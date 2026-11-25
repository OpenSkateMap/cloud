import { CITY_LANGUAGES, type CityLanguage, type CityNames, type Coordinate } from "@openskatemap/db/schema";
import { z } from "zod";
import type { Fetch } from "../auth/apple-tokens.ts";
import { err, ok, type Result } from "./result.ts";
import { completeNames, LOOKUP_USER_AGENT, type LookupFailure, WikidataIdSchema, wikidataLabels } from "./wikidata.ts";

/** Where a city's place and names come from; tests pass fixtures, so nothing calls out. */
export interface PlaceLookup {
  readonly nominatim: Fetch;
  readonly wikidata: Fetch;
  /** The least time between two Nominatim requests, anywhere: a second, by OpenStreetMap's usage policy. */
  readonly spacingMs: number;
  readonly pause: (milliseconds: number) => Promise<void>;
}

// Arrow functions: Workers refuse a `fetch` called as another object's method.
export const livePlaceLookup: PlaceLookup = {
  nominatim: (input, init) => fetch(input, init),
  wikidata: (input, init) => fetch(input, init),
  spacingMs: 1000,
  pause: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

export type PlaceFailure = LookupFailure | { readonly kind: "no_city"; readonly addressType: string | null };

export type Bbox = readonly [west: number, south: number, east: number, north: number];

const PolygonSchema = z.array(z.array(z.array(z.number()).min(2)).min(4));
const GeometrySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("Polygon"), coordinates: PolygonSchema }),
  z.object({ type: z.literal("MultiPolygon"), coordinates: z.array(PolygonSchema).min(1) }),
]);
export type PlaceGeometry = z.infer<typeof GeometrySchema>;

export interface FoundPlace {
  /** OpenStreetMap's `<type>/<id>`. */
  readonly id: string;
  /** In English (`accept-language=en`), else the local name. */
  readonly name: string;
  readonly countryCode: string;
  readonly addressType: string;
  readonly wikidataId: string | null;
  /** The place's own `name:<language>` tags in the apps' languages. */
  readonly osmNames: CityNames;
  /** Its boundary, simplified; a place mapped without one has only its box. */
  readonly area: { readonly kind: "boundary"; readonly geometry: PlaceGeometry } | { readonly kind: "box"; readonly bbox: Bbox };
}

// Finer than a city: the city around one is a wider answer (`findCityPlace`).
const SUB_CITY = new Set(["suburb", "quarter", "neighbourhood", "city_district", "borough", "village", "hamlet"]);
const WIDER_THAN_A_CITY = new Set(["state", "province", "country", "continent"]);

const degrees = z.string().transform(Number).pipe(z.number().finite());
const PlaceAnswerSchema = z.object({
  osm_type: z.enum(["node", "way", "relation"]),
  osm_id: z.int().positive(),
  addresstype: z.string(),
  name: z.string(),
  boundingbox: z.tuple([degrees, degrees, degrees, degrees]),
  address: z.object({ country_code: z.string().length(2).optional(), city: z.string().optional() }).default({}),
  extratags: z.record(z.string(), z.string()).nullish(),
  namedetails: z.record(z.string(), z.string()).nullish(),
  geojson: z.unknown(),
});
type Answer = z.infer<typeof PlaceAnswerSchema>;
// Nothing there (open sea) is an error object from `reverse`; `lookup` leaves out what it doesn't know.
const ReverseSchema = z.union([z.object({ error: z.string() }).transform(() => undefined), PlaceAnswerSchema]);
const LookupSchema = z.array(PlaceAnswerSchema);

async function ask<T extends z.ZodType>(
  path: "reverse" | "lookup",
  query: Record<string, string>,
  schema: T,
  lookup: PlaceLookup,
  timeoutMs = 4000,
): Promise<Result<z.infer<T>, LookupFailure>> {
  const service = "nominatim";
  const parameters = new URLSearchParams({
    format: "jsonv2",
    ...query,
    polygon_geojson: "1",
    polygon_threshold: "0.001",
    extratags: "1",
    namedetails: "1",
    "accept-language": "en",
  });
  let response: Response;
  try {
    response = await lookup.nominatim(`https://nominatim.openstreetmap.org/${path}?${parameters}`, {
      headers: { "User-Agent": LOOKUP_USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return err({ kind: "unreachable", service });
  }
  if (!response.ok) {
    await response.body?.cancel();
    return err({ kind: "unreachable", service, status: response.status });
  }
  const parsed = schema.safeParse(await response.json().catch(() => null));
  return parsed.success ? ok(parsed.data) : err({ kind: "unreadable", service });
}

const reverse = ({ latitude, longitude }: Coordinate, zoom: 5 | 6 | 8 | 10, lookup: PlaceLookup) =>
  ask("reverse", { lat: String(latitude), lon: String(longitude), zoom: String(zoom) }, ReverseSchema, lookup);

function placeOf(answer: Answer): Result<FoundPlace, PlaceFailure> {
  const countryCode = answer.address.country_code?.toUpperCase();
  if (!countryCode) return err({ kind: "no_city", addressType: answer.addresstype });
  const tags = answer.namedetails ?? {};
  const osmNames: CityNames = {};
  for (const language of CITY_LANGUAGES) {
    const tagged = tags[`name:${language}`]?.trim();
    if (tagged) osmNames[language] = tagged;
  }
  const geometry = GeometrySchema.safeParse(answer.geojson);
  const [south, north, west, east] = answer.boundingbox;
  const wikidataId = WikidataIdSchema.safeParse(answer.extratags?.wikidata);
  const name = answer.name.trim() || (tags.name ?? "").trim();
  if (!name) return err({ kind: "no_city", addressType: answer.addresstype });
  return ok({
    id: `${answer.osm_type}/${answer.osm_id}`,
    name,
    countryCode,
    addressType: answer.addresstype,
    wikidataId: wikidataId.success ? wikidataId.data : null,
    osmNames,
    area: geometry.success ? { kind: "boundary", geometry: geometry.data } : { kind: "box", bbox: [west, south, east, north] },
  });
}

/**
 * The city around a point. Zoom 10 first; when its `address.city` names a wider place (Camden → Greater London,
 * Mapo-gu → Seoul, Brooklyn → New York), zoom 6 then 5 for the place of that name; otherwise a suburb or village
 * (Kadıköy's Osmanağa, Canggu) gives way to zoom 8's district or regency (Kadıköy, Badung) unless that's a province;
 * otherwise zoom 10's own answer (Shibuya, Paris). Never a state or a country.
 */
export async function findCityPlace(point: Coordinate, lookup: PlaceLookup): Promise<Result<FoundPlace, PlaceFailure>> {
  const near = await reverse(point, 10, lookup);
  if (near.isErr()) return err(near.error);
  if (!near.value) return err({ kind: "no_city", addressType: null });
  const city = near.value.address.city?.trim();
  if (city && city !== near.value.name.trim()) {
    for (const zoom of [6, 5] as const) {
      await lookup.pause(lookup.spacingMs);
      const wider = await reverse(point, zoom, lookup);
      if (wider.isErr()) return err(wider.error);
      if (wider.value?.name.trim() === city) return placeOf(wider.value);
    }
  }
  if (city !== near.value.name.trim() && SUB_CITY.has(near.value.addresstype)) {
    await lookup.pause(lookup.spacingMs);
    const district = await reverse(point, 8, lookup);
    if (district.isErr()) return err(district.error);
    if (district.value && !WIDER_THAN_A_CITY.has(district.value.addresstype)) return placeOf(district.value);
  }
  return WIDER_THAN_A_CITY.has(near.value.addresstype) ? err({ kind: "no_city", addressType: near.value.addresstype }) : placeOf(near.value);
}

export interface RelationPlace {
  readonly relation: number;
  readonly place: FoundPlace;
  /** Nominatim's `linked_place`: the kind of place node the boundary stands for (`city` for a city proper). */
  readonly linkedPlace: string | null;
}

/** Up to 50 OpenStreetMap relations in one request, with their boundaries; a relation Nominatim doesn't know is left out. */
export async function relationPlaces(relationIds: readonly number[], lookup: PlaceLookup): Promise<Result<RelationPlace[], LookupFailure>> {
  // Fifty boundaries take Nominatim longer than one reverse lookup.
  const found = await ask("lookup", { osm_ids: relationIds.map((id) => `R${id}`).join(",") }, LookupSchema, lookup, 60_000);
  return found.map((answers) =>
    answers.flatMap((answer) => {
      const place = placeOf(answer);
      return answer.osm_type === "relation" && place.isOk() ? [{ relation: answer.osm_id, place: place.value, linkedPlace: answer.extratags?.linked_place ?? null }] : [];
    }),
  );
}

/** An OpenStreetMap relation by id, with its boundary: how big cities are made ahead of their first spot. */
export async function relationPlace(relationId: number, lookup: PlaceLookup): Promise<Result<FoundPlace, PlaceFailure>> {
  const found = await relationPlaces([relationId], lookup);
  if (found.isErr()) return err(found.error);
  const [first] = found.value;
  return first ? ok(first.place) : err({ kind: "no_city", addressType: null });
}

/**
 * Every app language, else `name`. A looked-up place's own OpenStreetMap names come before Wikidata's labels, which
 * can say "Municipality" or "Regency"; a preloaded city's item is the city itself, so its labels come first.
 */
export async function placeNames(place: FoundPlace, lookup: PlaceLookup, first: "osm" | "wikidata" = "osm"): Promise<Result<Record<CityLanguage, string>, LookupFailure>> {
  if (place.wikidataId === null) return ok(completeNames(place.osmNames, place.name));
  const labels = await wikidataLabels(place.wikidataId, lookup.wikidata);
  return labels.map((found) => completeNames(first === "osm" ? { ...found, ...place.osmNames } : { ...place.osmNames, ...found }, place.name));
}
