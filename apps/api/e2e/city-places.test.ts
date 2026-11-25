import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "@hono/zod-openapi";
import { type Database, openDatabase, schema } from "@openskatemap/db";
import { eq, inArray, like, sql } from "drizzle-orm";
import { createApp } from "../src/app.ts";
import type { PlaceLookup } from "../src/lib/nominatim.ts";
import { CitySchema } from "../src/lib/spot-schemas.ts";
import { ReviewQueueSchema, SubmissionSchema } from "../src/lib/submission-schemas.ts";
import { cellOf, preloadCity } from "../src/services/city-places.ts";
import { call, createRider, e2eUrl, read } from "./support.ts";

const { city, collection, osmPlace, placeMiss, spot, submission, submissionPlace, user } = schema;

type Rider = Awaited<ReturnType<typeof createRider>>;
type Box = readonly [west: number, south: number, east: number, north: number];

interface FixturePlace {
  readonly osmId: number;
  readonly name: string;
  readonly box: Box;
  readonly addressType?: string;
  readonly wikidata?: string;
  readonly osmNames?: Record<string, string>;
}

const inside = ([west, south, east, north]: Box, latitude: number, longitude: number) =>
  longitude >= west && longitude <= east && latitude >= south && latitude <= north;

const answer = (place: FixturePlace) => {
  const [west, south, east, north] = place.box;
  return {
    osm_type: "relation",
    osm_id: place.osmId,
    addresstype: place.addressType ?? "city",
    name: place.name,
    boundingbox: [String(south), String(north), String(west), String(east)],
    address: { country_code: "aq" },
    extratags: place.wikidata ? { wikidata: place.wikidata } : {},
    namedetails: { name: place.name, ...place.osmNames },
    geojson: { type: "Polygon", coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] },
  };
};

/** Nominatim and Wikidata as fixtures: places by box, labels by item, and boxes that answer 503. */
function fixtureLookup(places: FixturePlace[], labels: Record<string, Record<string, string>>, failing: Box[]) {
  const asked: string[] = [];
  const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const lookup: PlaceLookup = {
    nominatim: async (input) => {
      const url = new URL(input);
      asked.push(`${url.pathname}?${url.searchParams.get("lat") ?? url.searchParams.get("osm_ids")}`);
      if (url.pathname === "/lookup") {
        const id = Number(url.searchParams.get("osm_ids")?.slice(1));
        return respond(places.filter((place) => place.osmId === id).map(answer));
      }
      const latitude = Number(url.searchParams.get("lat"));
      const longitude = Number(url.searchParams.get("lon"));
      if (failing.some((box) => inside(box, latitude, longitude))) return respond({}, 503);
      const found = places.find((place) => inside(place.box, latitude, longitude));
      return respond(found ? answer(found) : { error: "Unable to geocode" });
    },
    wikidata: async (input) => {
      const id = new URL(input).pathname.split("/").at(-1)!.replace(".json", "");
      const entity = labels[id] ?? {};
      return respond({ entities: { [id]: { labels: Object.fromEntries(Object.entries(entity).map(([language, value]) => [language, { value }])) } } });
    },
    spacingMs: 0,
    pause: async () => {},
  };
  return { asked, lookup };
}

describe.skipIf(!e2eUrl)("automatic cities (database)", () => {
  const database = e2eUrl ? openDatabase(e2eUrl) : undefined;
  const tag = crypto.randomUUID().slice(0, 8);
  // A stretch of the Southern Ocean of its own each run, so stored places from other runs never answer.
  const south = -60 + Math.floor(Math.random() * 400) / 100;
  const west = -150 + Math.floor(Math.random() * 400) / 100;
  const box = (column: number): Box => [west + column * 0.2, south, west + column * 0.2 + 0.1, south + 0.1];
  const at = (column: number, east = 0.03, north = 0.03) => ({ latitude: south + north, longitude: west + column * 0.2 + east });
  const osmId = (index: number) => 900_000_000 + Math.floor(Math.random() * 90_000_000) * 10 + index;

  const alpha: FixturePlace = { osmId: osmId(1), name: `Alpha ${tag}`, box: box(0), wikidata: "Q4001", osmNames: { "name:ru": `Альфа ${tag}` } };
  const beta: FixturePlace = { osmId: osmId(2), name: `Beta ${tag}`, box: box(1) };
  const delta: FixturePlace = { osmId: osmId(4), name: `Delta ${tag}`, box: box(3) };
  const echo: FixturePlace = { osmId: osmId(5), name: `Echo ${tag}`, box: box(4) };
  const golf: FixturePlace = { osmId: osmId(7), name: `Golf ${tag}`, box: box(6), wikidata: "Q4007" };
  const hotel: FixturePlace = { osmId: osmId(8), name: `Hotel ${tag}`, box: box(7) };
  const juliet: FixturePlace = { osmId: osmId(11), name: `Juliet ${tag}`, box: [west + 0.83, south - 0.01, west + 0.97, south + 0.11] };
  const india: FixturePlace = { osmId: osmId(10), name: `India ${tag}`, box: box(8), wikidata: "Q4010", osmNames: { "name:ja": "インディア" } };
  const failingBox = box(2);
  const fixtures = fixtureLookup([alpha, beta, delta, echo, golf, hotel, india, juliet], { Q4001: { de: `Alfa ${tag}`, ru: `Альфа Викиданные ${tag}` }, Q4007: { ja: "ゴルフ" } }, [failingBox]);
  const cityApp = createApp({ placeLookup: fixtures.lookup });
  const places = [alpha, beta, delta, echo, golf, hotel, india, juliet].map((place) => `relation/${place.osmId}`);

  let db: Database;
  let rider: Rider, admin: Rider;
  const submissionIds: string[] = [];
  const handDrawn = { id: `e2e-hand-${tag}`, slug: `echo-${tag}` };

  const json = (as: Rider, method: string, body?: unknown): RequestInit => ({
    method,
    headers: { ...as.bearer, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const submit = async (as: Rider, point: { latitude: number; longitude: number }, extra: Record<string, unknown> = {}) => {
    const id = crypto.randomUUID();
    submissionIds.push(id);
    const { status, body } = await call(`/v1/submissions/${id}`, json(as, "PUT", { kind: "new_spot", title: "Rail", spotKind: "street", ...point, photos: [], ...extra }), {}, cityApp);
    expect(status).toBe(200);
    return SubmissionSchema.parse(body.data);
  };
  const approve = async (id: string) => {
    const [row] = await db.select({ updatedAt: submission.updatedAt }).from(submission).where(eq(submission.id, id));
    const { status, body } = await call(`/v1/review/${id}/approve`, json(admin, "POST", { seenUpdatedAt: row!.updatedAt.toISOString() }), {}, cityApp);
    expect(status).toBe(200);
    return SubmissionSchema.parse(body.data);
  };
  const spotCity = async (spotId: string) => (await db.select({ cityId: spot.cityId }).from(spot).where(eq(spot.id, spotId)))[0]?.cityId ?? null;
  const cityOf = async (placeId: string) => (await db.select().from(city).where(eq(city.osmPlaceId, placeId)))[0];
  const listed = async () => (await read(z.object({ cities: z.array(CitySchema) }), "/v1/cities", { headers: rider.bearer })).cities.map((row) => row.id);

  beforeAll(async () => {
    db = (await database!).db;
    rider = await createRider(db, "Lookup Rider");
    admin = await createRider(db, "Lookup Admin");
    await db.update(user).set({ role: "admin" }).where(eq(user.id, admin.userId));
    const [handWest, handSouth] = box(4);
    await db.insert(city).values({
      ...handDrawn,
      name: "Hand Drawn",
      names: { ru: "Нарисованный" },
      countryCode: "NZ",
      area: sql`ST_Multi(ST_MakeEnvelope(${handWest + 0.05}, ${handSouth}, ${handWest + 0.15}, ${handSouth + 0.1}, 4326))`,
    });
  });

  afterAll(async () => {
    const spotIds = (await db.select({ id: submission.spotId }).from(submission).where(inArray(submission.id, submissionIds))).flatMap((row) => (row.id ? [row.id] : []));
    await db.delete(submission).where(inArray(submission.id, submissionIds));
    if (spotIds.length > 0) await db.delete(spot).where(inArray(spot.id, spotIds));
    await db.delete(spot).where(like(spot.id, `e2e-lookup-${tag}-%`));
    await db.delete(city).where(inArray(city.osmPlaceId, places));
    await db.delete(city).where(eq(city.id, handDrawn.id));
    await db.delete(osmPlace).where(inArray(osmPlace.id, places));
    await db.delete(placeMiss).where(like(placeMiss.cell, `${Math.floor(south * 100)}:%`));
    await db.delete(collection).where(inArray(collection.ownerId, [rider.userId, admin.userId]));
    await db.delete(user).where(inArray(user.id, [rider.userId, admin.userId]));
    await (await database!).close();
  });

  test("a spot outside every city is looked up when it's submitted, and its approval files it in a city made from that place", async () => {
    const asked = fixtures.asked.length;
    const pending = await submit(rider, at(0));
    expect(pending.cityId).toBeNull();
    expect(fixtures.asked.length).toBe(asked + 1);
    const [link] = await db.select().from(submissionPlace).where(eq(submissionPlace.submissionId, pending.id));
    expect(link?.osmPlaceId).toBe(`relation/${alpha.osmId}`);
    const [stored] = await db.select({ updatedAt: submission.updatedAt }).from(submission).where(eq(submission.id, pending.id));
    expect(stored!.updatedAt.toISOString()).toBe(pending.updatedAt);
    expect(await cityOf(`relation/${alpha.osmId}`)).toBeUndefined();

    const approved = await approve(pending.id);
    expect(fixtures.asked.length).toBe(asked + 1);
    const made = await cityOf(`relation/${alpha.osmId}`);
    expect(made).toMatchObject({ slug: `alpha-${tag}`, name: `Alpha ${tag}`, countryCode: "AQ", wikidataId: "Q4001" });
    expect(made!.names).toMatchObject({ en: `Alpha ${tag}`, ru: `Альфа ${tag}`, de: `Alfa ${tag}`, ja: `Alpha ${tag}` });
    expect(await spotCity(approved.spotId!)).toBe(made!.id);
    expect(approved.cityId).toBe(made!.id);
    expect(await listed()).toContain(made!.id);
  });

  test("another spot in the same place, or inside its city, never asks again", async () => {
    const asked = fixtures.asked.length;
    await submit(rider, at(0, 0.07, 0.07));
    expect(fixtures.asked.length).toBe(asked);
    const inCity = await submit(rider, at(0, 0.05, 0.02));
    expect(inCity.cityId).toBe((await cityOf(`relation/${alpha.osmId}`))!.id);
    expect(fixtures.asked.length).toBe(asked);
  });

  test("an admin's own spot is published at once and filed right after, from a place looked up then", async () => {
    const published = await submit(admin, at(1));
    expect(published.status).toBe("approved");
    const made = await cityOf(`relation/${beta.osmId}`);
    expect(made?.name).toBe(`Beta ${tag}`);
    expect(await spotCity(published.spotId!)).toBe(made!.id);
  });

  test("a failed lookup leaves the spot outside every city, and remembers nothing", async () => {
    const [failWest, failSouth] = failingBox;
    const point = { latitude: failSouth + 0.05, longitude: failWest + 0.05 };
    const published = await submit(admin, point);
    expect(await spotCity(published.spotId!)).toBeNull();
    expect(await db.select().from(placeMiss).where(eq(placeMiss.cell, cellOf(point)))).toEqual([]);
  });

  test("a private spot never looks anything up", async () => {
    const asked = fixtures.asked.length;
    const collectionId = crypto.randomUUID();
    await call(`/v1/collections/${collectionId}`, json(rider, "PUT", { name: "Secret", visibility: "private" }), {}, cityApp);
    const saved = await submit(rider, at(3), { collectionId });
    expect(saved.status).toBe("approved");
    expect(fixtures.asked.length).toBe(asked);
    expect(await cityOf(`relation/${delta.osmId}`)).toBeUndefined();
  });

  test("a city made by a lookup takes a free slug and only what other cities don't cover, leaving them untouched", async () => {
    const before = (await db.select().from(city).where(eq(city.id, handDrawn.id)))[0]!;
    const published = await submit(admin, at(4, 0.02));
    const made = await cityOf(`relation/${echo.osmId}`);
    expect(made?.slug).toBe(`echo-${tag}-2`);
    expect(await spotCity(published.spotId!)).toBe(made!.id);
    expect((await db.select().from(city).where(eq(city.id, handDrawn.id)))[0]).toEqual(before);
    const [overlap] = await db.execute<{ shared: number }>(sql`
      select ST_Area(ST_Intersection(a.area, b.area)) as shared from city a, city b where a.id = ${made!.id} and b.id = ${handDrawn.id}
    `).then((result) => result.rows);
    expect(Number(overlap!.shared)).toBe(0);
  });

  test("a rejected submission makes no city, though its place stays stored", async () => {
    const pending = await submit(rider, at(7));
    const [row] = await db.select({ updatedAt: submission.updatedAt }).from(submission).where(eq(submission.id, pending.id));
    const { status } = await call(`/v1/review/${pending.id}/reject`, json(admin, "POST", { reason: "not_a_spot", seenUpdatedAt: row!.updatedAt.toISOString() }), {}, cityApp);
    expect(status).toBe(200);
    expect(await db.select().from(osmPlace).where(eq(osmPlace.id, `relation/${hotel.osmId}`))).toHaveLength(1);
    expect(await cityOf(`relation/${hotel.osmId}`)).toBeUndefined();
  });

  test("where Nominatim finds no city, the cell is remembered until it expires", async () => {
    const sea = { latitude: south + 0.055, longitude: west + 5 * 0.2 + 0.055 };
    const asked = fixtures.asked.length;
    const first = await submit(admin, sea);
    expect(await spotCity(first.spotId!)).toBeNull();
    expect(fixtures.asked.length).toBe(asked + 1);
    await submit(admin, { latitude: sea.latitude + 0.001, longitude: sea.longitude + 0.001 });
    expect(fixtures.asked.length).toBe(asked + 1);

    await db.update(placeMiss).set({ expiresAt: sql`now() - interval '1 second'` }).where(eq(placeMiss.cell, cellOf(sea)));
    await submit(admin, sea);
    expect(fixtures.asked.length).toBe(asked + 2);
  });

  test("a preloaded big city stays out of the cities list until it has a published public spot, and preloading again keeps it", async () => {
    const created = await preloadCity(db, fixtures.lookup, { wikidata: "Q4007", relation: golf.osmId });
    expect(created._unsafeUnwrap().kind).toBe("created");
    const made = (await cityOf(`relation/${golf.osmId}`))!;
    expect(made.names).toMatchObject({ en: `Golf ${tag}`, ja: "ゴルフ" });
    expect(await listed()).not.toContain(made.id);

    await db.insert(spot).values({ id: `e2e-lookup-${tag}-golf`, title: "Golf ledge", kind: "street", location: at(6) });
    expect(await listed()).toContain(made.id);

    const asked = fixtures.asked.length;
    expect((await preloadCity(db, fixtures.lookup, { wikidata: "Q4007", relation: golf.osmId }))._unsafeUnwrap()).toEqual({ kind: "kept", cityId: made.id });
    expect(fixtures.asked.length).toBe(asked);
  });

  test("a submission in a city made ahead of its first spot names that city on its review card", async () => {
    const created = (await preloadCity(db, fixtures.lookup, { wikidata: "Q4010", relation: india.osmId }))._unsafeUnwrap();
    const pending = await submit(rider, at(8));
    expect(pending.cityId).toBe(created.cityId);
    expect(await listed()).not.toContain(created.cityId);

    const queue = ReviewQueueSchema.parse((await call(`/v1/review/queue?cityId=${created.cityId}`, { headers: admin.bearer })).body.data);
    expect(queue.items.find((item) => item.id === pending.id)?.cityId).toBe(created.cityId);
    expect(queue.cities.find((row) => row.id === created.cityId)).toMatchObject({ name: `India ${tag}`, names: { en: `India ${tag}`, ja: "インディア" } });
  });

  test("preloading a place whose Wikidata item a hand-drawn city has keeps that city as drawn", async () => {
    await db.update(city).set({ wikidataId: "Q4005" }).where(eq(city.id, handDrawn.id));
    const before = (await db.select().from(city).where(eq(city.id, handDrawn.id)))[0]!;
    expect((await preloadCity(db, fixtures.lookup, { wikidata: "Q4005", relation: osmId(9) }))._unsafeUnwrap()).toEqual({ kind: "kept", cityId: handDrawn.id });
    expect((await db.select().from(city).where(eq(city.id, handDrawn.id)))[0]).toEqual(before);
  });

  test("preloading a wider place around a hand-drawn city keeps that city and makes none", async () => {
    const before = (await db.select().from(city).where(eq(city.id, handDrawn.id)))[0]!;
    expect((await preloadCity(db, fixtures.lookup, { wikidata: "Q4011", relation: juliet.osmId }))._unsafeUnwrap()).toEqual({ kind: "kept", cityId: handDrawn.id });
    expect(await cityOf(`relation/${juliet.osmId}`)).toBeUndefined();
    expect((await db.select().from(city).where(eq(city.id, handDrawn.id)))[0]).toEqual(before);
  });
});
