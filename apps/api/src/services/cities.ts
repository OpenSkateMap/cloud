import type { Database } from "@openskatemap/db";
import { city, type CityNames } from "@openskatemap/db/schema";
import { asc, type SQL, sql } from "drizzle-orm";
import type { Bbox } from "../lib/nominatim.ts";
import { CITY_BOUNDARIES_LICENSE, type CityBoundaries, type CityBoundary } from "../lib/spot-schemas.ts";

export interface CityInput {
  readonly slug: string;
  readonly name: string;
  readonly countryCode: string;
  readonly area: SQL;
  /** Left out, a city saved again keeps the names it has. */
  readonly names?: { readonly byLanguage: CityNames; readonly wikidataId: string | null } | undefined;
}

export const boxArea = ([west, south, east, north]: Bbox) => sql`ST_Multi(ST_MakeEnvelope(${west}, ${south}, ${east}, ${north}, 4326))`;

export function saveCity(db: Database, input: CityInput) {
  return db.transaction((tx) => writeCity(tx, input));
}

/** Inserts or updates the city by slug and re-files every spot and pending submission; the number of spots that moved. */
export async function writeCity(tx: Database, { slug, name, countryCode, area, names }: CityInput): Promise<number> {
  const named = names ? { names: names.byLanguage, wikidataId: names.wikidataId } : {};
  await tx
    .insert(city)
    .values({ id: crypto.randomUUID(), slug, name, countryCode, area, ...named })
    .onConflictDoUpdate({ target: city.slug, set: { name, countryCode, area, ...named } });
  const moved = await tx.execute(sql`
    update spot set city_id = spot_city_for(location) where city_id is distinct from spot_city_for(location)
  `);
  await tx.execute(sql`
    update submission set city_id = spot_city_for(location)
    where status = 'pending' and city_id is distinct from spot_city_for(location)
  `);
  return moved.rowCount ?? 0;
}

/** Every city's boundary as GeoJSON, read from `city` alone: stored places and misses can tell where a pending spot was sent. */
export async function cityBoundaries(db: Database, generatedAt = new Date()): Promise<CityBoundaries> {
  const rows = await db
    .select({
      id: city.id,
      slug: city.slug,
      name: city.name,
      names: city.names,
      countryCode: city.countryCode,
      wikidataId: city.wikidataId,
      fromOpenStreetMap: sql<boolean>`${city.osmPlaceId} is not null`,
      // RFC 7946: rings follow the right-hand rule; 6 decimals (10 cm) is far finer than boundaries simplified to about 100 m.
      geometry: sql<CityBoundary["geometry"]>`ST_AsGeoJSON(ST_ForcePolygonCCW(${city.area}), 6)::json`,
    })
    .from(city)
    .orderBy(asc(city.slug));
  return {
    type: "FeatureCollection",
    ...CITY_BOUNDARIES_LICENSE,
    generatedAt: generatedAt.toISOString(),
    features: rows.map(({ geometry, fromOpenStreetMap, ...properties }) => ({
      type: "Feature",
      geometry,
      properties: { ...properties, source: fromOpenStreetMap ? "openstreetmap" : "hand-drawn" },
    })),
  };
}
