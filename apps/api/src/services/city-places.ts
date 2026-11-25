import type { Database } from "@openskatemap/db";
import { type Coordinate, city, lookupLease, osmPlace, placeMiss, spot, submission, submissionPlace } from "@openskatemap/db/schema";
import { and, asc, eq, gt, isNull, like, not, sql } from "drizzle-orm";
import type { Context } from "hono";
import type { AppEnv } from "../env.ts";
import { type FoundPlace, findCityPlace, type PlaceFailure, type PlaceLookup, placeNames, relationPlace } from "../lib/nominatim.ts";
import { onDatabase } from "../lib/on-database.ts";
import { err, ok, type Result } from "../lib/result.ts";
import type { Submission } from "../lib/submission-schemas.ts";
import { inTransaction } from "../lib/transaction.ts";
import { boxArea } from "./cities.ts";
import { isPrivateSubmission } from "./submissions.ts";

export type CityFiling = { readonly kind: "filed"; readonly cityId: string; readonly created: boolean } | { readonly kind: "not_needed" };

export type CityFilingFailure =
  | PlaceFailure
  | { readonly kind: "outside_place"; readonly placeId: string | null }
  | { readonly kind: "city_exists"; readonly placeId: string }
  | { readonly kind: "busy" };

type PlaceAnswer = { readonly kind: "city" } | { readonly kind: "place"; readonly id: string };

const MISS_DAYS = 21;
// 8 waits of a second plus a lookup's 18 at most (four requests at 4 s, two pauses) fit `waitUntil`'s 30.
const LEASE_WAITS = 8;
const LEASE_SECONDS = 30;

const pointOf = ({ latitude, longitude }: Coordinate) => sql`ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)`;

/** The 0.01° grid cell a point is in: about a kilometre north to south, less east to west away from the equator. */
export const cellOf = ({ latitude, longitude }: Coordinate) => `${Math.floor(latitude * 100)}:${Math.floor(longitude * 100)}`;

export function slugOf(name: string, placeId: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 36)
    .replace(/^-+|-+$/g, "");
  return slug.length >= 2 ? slug : placeId.replace("/", "-");
}

function areaOf(place: FoundPlace) {
  return place.area.kind === "boundary"
    ? sql`ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(place.area.geometry)}), 4326)), 3))`
    : boxArea(place.area.bbox);
}

async function takeLease(db: Database): Promise<boolean> {
  const taken = await db
    .insert(lookupLease)
    .values({ service: "nominatim", until: sql`now() + make_interval(secs => ${LEASE_SECONDS})` })
    .onConflictDoUpdate({ target: lookupLease.service, set: { until: sql`excluded.until` }, setWhere: sql`${lookupLease.until} <= now()` })
    .returning({ service: lookupLease.service });
  return taken.length > 0;
}

// Held a moment longer than the work, so the next request anywhere comes at least `spacingMs` after this one.
const releaseLease = (db: Database, lookup: PlaceLookup) =>
  db
    .update(lookupLease)
    .set({ until: sql`now() + make_interval(secs => ${lookup.spacingMs / 1000})` })
    .where(eq(lookupLease.service, "nominatim"));

/** Runs `work` while holding the one Nominatim lease, after `ready` (checked again on every wait) hasn't answered without it. */
async function withLease<T>(db: Database, lookup: PlaceLookup, ready: () => Promise<T | undefined>, work: () => Promise<T>): Promise<T | "busy"> {
  for (let waits = 0; ; waits += 1) {
    const answered = await ready();
    if (answered !== undefined) return answered;
    if (await takeLease(db)) break;
    if (waits === LEASE_WAITS) return "busy";
    await lookup.pause(Math.max(lookup.spacingMs, 100));
  }
  try {
    return await work();
  } finally {
    await releaseLease(db, lookup);
  }
}

async function cachedAnswer(db: Database, point: Coordinate): Promise<Result<PlaceAnswer, CityFilingFailure> | undefined> {
  const [inCity] = await db.execute<{ id: string | null }>(sql`select spot_city_for(${pointOf(point)}) as id`).then((result) => result.rows);
  if (inCity?.id) return ok({ kind: "city" });
  const [place] = await db
    .select({ id: osmPlace.id })
    .from(osmPlace)
    .where(sql`ST_Contains(${osmPlace.area}, ${pointOf(point)})`)
    .orderBy(sql`ST_Area(${osmPlace.area})`, asc(osmPlace.id))
    .limit(1);
  if (place) return ok({ kind: "place", id: place.id });
  const [miss] = await db
    .select({ reason: placeMiss.reason })
    .from(placeMiss)
    .where(and(eq(placeMiss.cell, cellOf(point)), gt(placeMiss.expiresAt, sql`now()`)));
  if (miss) return err(miss.reason === "no_city" ? { kind: "no_city", addressType: null } : { kind: "outside_place", placeId: null });
  return undefined;
}

const recordMiss = (db: Database, point: Coordinate, reason: "no_city" | "outside_place") => {
  const expiresAt = sql`now() + make_interval(days => ${MISS_DAYS})`;
  return db.insert(placeMiss).values({ cell: cellOf(point), reason, expiresAt }).onConflictDoUpdate({ target: placeMiss.cell, set: { reason, expiresAt } });
};

async function storePlace(db: Database, place: FoundPlace, lookup: PlaceLookup, namesFirst: "osm" | "wikidata" = "osm"): Promise<Result<string, PlaceFailure>> {
  const names = await placeNames(place, lookup, namesFirst);
  if (names.isErr()) return err(names.error);
  await db
    .insert(osmPlace)
    .values({
      id: place.id,
      name: place.name,
      names: names.value,
      wikidataId: place.wikidataId,
      slug: slugOf(place.name, place.id),
      countryCode: place.countryCode,
      addressType: place.addressType,
      area: areaOf(place),
    })
    .onConflictDoNothing();
  return ok(place.id);
}

/**
 * The city or stored place around a point, asking Nominatim only when neither is there and no miss is remembered for
 * its cell: so a place is looked up once, however many spots it gets.
 */
async function placeAt(db: Database, point: Coordinate, lookup: PlaceLookup): Promise<Result<PlaceAnswer, CityFilingFailure>> {
  const answer = await withLease(db, lookup, () => cachedAnswer(db, point), async (): Promise<Result<PlaceAnswer, CityFilingFailure>> => {
    const found = await findCityPlace(point, lookup);
    if (found.isErr()) {
      if (found.error.kind === "no_city") await recordMiss(db, point, "no_city");
      return err(found.error);
    }
    const stored = await storePlace(db, found.value, lookup);
    if (stored.isErr()) return err(stored.error);
    const [contains] = await db
      .select({ id: osmPlace.id })
      .from(osmPlace)
      .where(and(eq(osmPlace.id, stored.value), sql`ST_Contains(${osmPlace.area}, ${pointOf(point)})`));
    if (contains) return ok({ kind: "place", id: stored.value });
    // A boundary simplified to about 100 m can leave a point near its edge outside.
    await recordMiss(db, point, "outside_place");
    return err({ kind: "outside_place", placeId: stored.value });
  });
  return answer === "busy" ? err({ kind: "busy" }) : answer;
}

async function freeSlug(tx: Database, base: string): Promise<string> {
  const taken = new Set((await tx.select({ slug: city.slug }).from(city).where(like(city.slug, `${base}%`))).map((row) => row.slug));
  let slug = base;
  for (let suffix = 2; taken.has(slug); suffix += 1) slug = `${base}-${suffix}`;
  return slug;
}

/**
 * Makes a city of a stored place, never touching an existing one: its area is the place's minus every city's, its slug
 * a free one, and a place whose OpenStreetMap or Wikidata id a city already has makes none. With `spotId`, only when
 * that spot ends up inside it, so no city is made without a spot.
 */
async function createCity(tx: Database, placeId: string, spotId?: string): Promise<Result<string, CityFilingFailure>> {
  const [place] = await tx.select({ slug: osmPlace.slug, wikidataId: osmPlace.wikidataId }).from(osmPlace).where(eq(osmPlace.id, placeId));
  if (!place) return err({ kind: "outside_place", placeId });
  const [known] = await tx
    .select({ id: city.id })
    .from(city)
    .where(place.wikidataId === null ? eq(city.osmPlaceId, placeId) : sql`${city.osmPlaceId} = ${placeId} or ${city.wikidataId} = ${place.wikidataId}`)
    .limit(1);
  if (known) return err({ kind: "city_exists", placeId });
  const id = crypto.randomUUID();
  const slug = await freeSlug(tx, place.slug);
  const holds = spotId === undefined ? sql`true` : sql`ST_Contains(free.area, (select location from spot where id = ${spotId}))`;
  const inserted = await tx.execute(sql`
    with place as (select * from osm_place where id = ${placeId}),
    free as (
      select ST_Multi(ST_CollectionExtract(coalesce(ST_Difference(place.area, (select ST_Union(c.area) from city c where c.area && place.area)), place.area), 3)) as area
      from place
    )
    insert into city (id, slug, name, names, wikidata_id, osm_place_id, country_code, area)
    select ${id}, ${slug}, place.name, place.names, place.wikidata_id, place.id, place.country_code, free.area
    from place, free
    where not ST_IsEmpty(free.area) and ${holds}
  `);
  return (inserted.rowCount ?? 0) > 0 ? ok(id) : err({ kind: "outside_place", placeId });
}

/** Files the spots and pending submissions inside a new city; its area overlaps no other city, so nothing else moves. */
async function fileInto(tx: Database, cityId: string) {
  const area = sql`(select area from city where id = ${cityId})`;
  await tx.execute(sql`
    update spot set city_id = spot_city_for(location)
    where location::geography && ${area}::geography and city_id is distinct from spot_city_for(location)
  `);
  await tx.execute(sql`
    update submission set city_id = spot_city_for(location)
    where status = 'pending' and city_id is null and ST_Intersects(location, ${area})
  `);
}

async function fileSpotInPlace(tx: Database, spotId: string, answer: PlaceAnswer): Promise<Result<CityFiling, CityFilingFailure>> {
  let created = false;
  if (answer.kind === "place") {
    const made = await createCity(tx, answer.id, spotId);
    if (made.isErr()) return err(made.error);
    await fileInto(tx, made.value);
    created = true;
  } else {
    await tx.execute(sql`update spot set city_id = spot_city_for(location) where id = ${spotId} and city_id is null`);
  }
  const [filed] = await tx.select({ cityId: spot.cityId }).from(spot).where(eq(spot.id, spotId));
  return filed?.cityId ? ok({ kind: "filed", cityId: filed.cityId, created }) : err({ kind: "outside_place", placeId: answer.kind === "place" ? answer.id : null });
}

const cityless = (spotId: string) =>
  and(eq(spot.id, spotId), isNull(spot.cityId), eq(spot.status, "published"), eq(spot.visibility, "public"));

/** Gives a published public spot outside every city its city: from a stored place, else one looked up now. Safe to repeat. */
export async function fileSpot(db: Database, lookup: PlaceLookup, spotId: string): Promise<Result<CityFiling, CityFilingFailure>> {
  const [row] = await db.select({ location: spot.location }).from(spot).where(cityless(spotId));
  if (!row) return ok({ kind: "not_needed" });
  const answer = await placeAt(db, row.location, lookup);
  if (answer.isErr()) return err(answer.error);
  return inTransaction(db, (tx) => fileSpotInPlace(tx, spotId, answer.value));
}

/** In an approval's transaction: the spot's city from a place a lookup already stored, never calling out; false when there's none. */
export async function fileFromStoredPlace(tx: Database, spotId: string): Promise<boolean> {
  const [row] = await tx
    .select({ placeId: osmPlace.id })
    .from(spot)
    .innerJoin(osmPlace, sql`ST_Contains(${osmPlace.area}, ${spot.location})`)
    .where(cityless(spotId))
    .orderBy(sql`ST_Area(${osmPlace.area})`, asc(osmPlace.id))
    .limit(1);
  if (!row) return false;
  try {
    // A savepoint: a city that can't be made (a race on its slug) never fails the approval.
    const filed = await tx.transaction((savepoint) => fileSpotInPlace(savepoint, spotId, { kind: "place", id: row.placeId }));
    return filed.isOk();
  } catch (error) {
    console.error("A city from a stored place failed", { spotId, error: error instanceof Error ? error.name : typeof error });
    return false;
  }
}

/** Looks up the place a pending public submission outside every city is in, so its approval can make the city at once. */
export async function locateSubmission(db: Database, lookup: PlaceLookup, submissionId: string): Promise<Result<string | undefined, CityFilingFailure>> {
  const [row] = await db
    .select({ location: submission.location })
    .from(submission)
    .leftJoin(submissionPlace, eq(submissionPlace.submissionId, submission.id))
    .where(and(eq(submission.id, submissionId), eq(submission.status, "pending"), isNull(submission.cityId), isNull(submissionPlace.osmPlaceId), not(isPrivateSubmission)));
  if (!row) return ok(undefined);
  const answer = await placeAt(db, row.location, lookup);
  if (answer.isErr()) return err(answer.error);
  if (answer.value.kind === "city") return ok(undefined);
  await db.insert(submissionPlace).values({ submissionId, osmPlaceId: answer.value.id }).onConflictDoNothing();
  return ok(answer.value.id);
}

function report(label: string, subject: Record<string, string>, result: Result<unknown, CityFilingFailure> | undefined) {
  if (!result?.isErr()) return;
  const failure = result.error;
  const log = failure.kind === "unreachable" || failure.kind === "unreadable" || failure.kind === "busy" ? console.error : console.warn;
  log(label, { ...subject, ...failure });
}

/**
 * After a public spot outside every city is submitted (or an edit moves one there), its place is looked up off the
 * request; after one is published without a city (an admin's own, or before its lookup landed), its city is made.
 */
export function findCityAfter(c: Context<AppEnv>, decided: Submission) {
  const lookup = c.var.placeLookup;
  if (lookup === null || decided.collectionId !== null || decided.cityId !== null) return;
  if (decided.kind === "edit_spot" && !decided.changedFields.includes("location")) return;
  const { spotId } = decided;
  if (decided.status === "pending") {
    c.executionCtx.waitUntil(
      onDatabase(c.env, "Place lookup", async (db) => report("Place lookup failed", { submissionId: decided.id }, await locateSubmission(db, lookup, decided.id))),
    );
  } else if (decided.status === "approved" && spotId !== null) {
    c.executionCtx.waitUntil(onDatabase(c.env, "Filing a spot", async (db) => report("Filing a spot failed", { spotId }, await fileSpot(db, lookup, spotId))));
  }
}

export interface PreloadEntry {
  readonly wikidata: string;
  readonly relation: number;
  /** In English; else the relation's own name. */
  readonly name?: string;
}

export type Preloaded = { readonly kind: "created"; readonly cityId: string } | { readonly kind: "kept"; readonly cityId: string };

/** The city already made from the entry's relation or Wikidata item, which preloading leaves as it is. */
export async function preloadedCity(db: Database, { wikidata, relation }: PreloadEntry): Promise<{ id: string; slug: string } | undefined> {
  const [known] = await db
    .select({ id: city.id, slug: city.slug })
    .from(city)
    .where(sql`${city.osmPlaceId} = ${`relation/${relation}`} or ${city.wikidataId} = ${wikidata}`)
    .limit(1);
  return known;
}

/**
 * Makes a big city ahead of its first spot from its OpenStreetMap relation. A city already made from it or its
 * Wikidata item, or one lying inside it, stays as it is and no city is made.
 */
export async function preloadCity(db: Database, lookup: PlaceLookup, entry: PreloadEntry): Promise<Result<Preloaded, CityFilingFailure>> {
  const placeId = `relation/${entry.relation}`;
  const existing = async () => {
    const known = await preloadedCity(db, entry);
    return known ? ok<Preloaded, CityFilingFailure>({ kind: "kept", cityId: known.id }) : undefined;
  };
  const stored = await withLease(db, lookup, existing, async (): Promise<Result<Preloaded | undefined, CityFilingFailure>> => {
    const [cached] = await db.select({ id: osmPlace.id }).from(osmPlace).where(eq(osmPlace.id, placeId));
    if (cached) return ok(undefined);
    const found = await relationPlace(entry.relation, lookup);
    if (found.isErr()) return err(found.error);
    const saved = await storePlace(db, { ...found.value, wikidataId: entry.wikidata, name: entry.name ?? found.value.name }, lookup, "wikidata");
    return saved.isErr() ? err(saved.error) : ok(undefined);
  });
  if (stored === "busy") return err({ kind: "busy" });
  if (stored.isErr()) return err(stored.error);
  if (stored.value) return ok(stored.value);
  return inTransaction(db, async (tx): Promise<Result<Preloaded, CityFilingFailure>> => {
    // A wider place around a city drawn by hand (the City of Belgrade around Belgrade) would only ring it.
    const [inside] = await tx.execute<{ id: string }>(sql`
      select c.id from city c, osm_place p
      where p.id = ${placeId} and c.area && p.area and ST_Area(ST_Intersection(c.area, p.area)) >= 0.9 * ST_Area(c.area)
      limit 1
    `).then((result) => result.rows);
    if (inside) return ok({ kind: "kept", cityId: inside.id });
    const made = await createCity(tx, placeId);
    if (made.isErr()) return err(made.error);
    await fileInto(tx, made.value);
    return ok({ kind: "created", cityId: made.value });
  });
}
