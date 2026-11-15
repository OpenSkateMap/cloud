import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "@hono/zod-openapi";
import { type Database, openDatabase, schema } from "@openskatemap/db";
import { eq, inArray, max, sql } from "drizzle-orm";
import { CitySchema, NearbySpotSchema, SpotDetailsSchema, type SpotIndexRow, SyncPageSchema } from "../src/lib/spot-schemas.ts";
import { call, createRider, e2eUrl, read } from "./support.ts";

const { city, spot, spotPhoto, user } = schema;

describe.skipIf(!e2eUrl)("spots (database)", () => {
  const database = e2eUrl ? openDatabase(e2eUrl) : undefined;
  const tag = crypto.randomUUID().slice(0, 8);
  const cityId = `e2e-city-${tag}`;
  const id = (name: string) => `e2e-${tag}-${name}`;
  const southbank = { latitude: 51.5065, longitude: -0.1167 };
  const nextDoor = { latitude: 51.5069, longitude: -0.1161 };
  const macba = { latitude: 41.3833, longitude: 2.1667 };
  let db: Database;
  let rider: Awaited<ReturnType<typeof createRider>>;
  let start = 0;

  const latestVersion = async () => (await db.select({ version: max(spot.version) }).from(spot))[0]?.version ?? 0;
  const versionOf = async (spotId: string) =>
    (await db.select({ version: spot.version, cityId: spot.cityId }).from(spot).where(eq(spot.id, spotId)))[0];

  async function pullAll(cursor: number, limit: number) {
    const local = new Map<string, SpotIndexRow>();
    const pages = [];
    for (let next = cursor; ; ) {
      const page = await read(SyncPageSchema, `/v1/sync/spots?cursor=${next}&limit=${limit}`, { headers: rider.bearer });
      pages.push(page);
      for (const row of page.items) local.set(row.id, row);
      for (const gone of page.tombstones) local.delete(gone);
      next = page.nextCursor;
      if (!page.hasMore) return { local, pages, cursor: next };
    }
  }

  beforeAll(async () => {
    db = (await database!).db;
    rider = await createRider(db, "Undercroft Local");
    // An app that has synced holds a cursor above 0; from 0 the sync sends no tombstones, and an empty table's latest is 0.
    await db.insert(spot).values({ id: id("synced"), title: "Already Synced", kind: "street", location: macba });
    start = await latestVersion();
    await db.insert(city).values({
      id: cityId,
      slug: `e2e-${tag}`,
      name: `E2E Southbank ${tag}`,
      countryCode: "GB",
      area: sql`ST_Multi(ST_MakeEnvelope(-0.125, 51.50, -0.105, 51.51, 4326))`,
    });
  });

  afterAll(async () => {
    await db.delete(spot).where(sql`${spot.id} like ${`e2e-${tag}-%`}`);
    await db.delete(city).where(eq(city.id, cityId));
    await db.delete(user).where(eq(user.id, rider.userId));
    await (await database!).close();
  });

  test("every write takes a new version, and the city follows the location", async () => {
    await db.insert(spot).values({ id: id("undercroft"), title: "Southbank Undercroft", kind: "plaza", location: southbank, createdBy: rider.userId, obstacles: ["ledges", "banks"] });
    await db.insert(spot).values({ id: id("nextdoor"), title: "Next Door", kind: "street", location: nextDoor });
    await db.insert(spot).values({ id: id("macba"), title: "MACBA", kind: "plaza", location: macba });
    const undercroft = await versionOf(id("undercroft"));
    const nextdoor = await versionOf(id("nextdoor"));
    const far = await versionOf(id("macba"));
    expect(undercroft!.version).toBeGreaterThan(start);
    expect(nextdoor!.version).toBeGreaterThan(undercroft!.version);
    expect(far!.version).toBeGreaterThan(nextdoor!.version);
    expect([undercroft!.cityId, nextdoor!.cityId]).toEqual([cityId, cityId]);
    expect(far!.cityId).not.toBe(cityId);

    const [stored] = await db.select({ location: spot.location, srid: sql<number>`ST_SRID(${spot.location})` }).from(spot).where(eq(spot.id, id("undercroft")));
    expect(stored).toEqual({ location: southbank, srid: 4326 });
  });

  test("a photo change is a spot change, so the cover syncs", async () => {
    const before = (await versionOf(id("undercroft")))!.version;
    await db.insert(spotPhoto).values({ id: id("photo-0"), spotId: id("undercroft"), r2Key: `spots/${tag}/0.jpg`, width: 1200, height: 900, thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI", credit: null, uploadedBy: rider.userId, hasPermission: true, position: 0 });
    await db.insert(spotPhoto).values({ id: id("photo-1"), spotId: id("undercroft"), r2Key: `spots/${tag}/1.jpg`, width: 900, height: 1200, thumbhash: "2QcSHQRnh493V4dIh4eXh1h4kJUI", credit: "@someone", hasPermission: true, position: 1 });
    expect((await versionOf(id("undercroft")))!.version).toBeGreaterThan(before);
  });

  test("sync pages through every change after a cursor, with removals as tombstones", async () => {
    await db.update(spot).set({ status: "removed" }).where(eq(spot.id, id("nextdoor")));
    await db.update(spot).set({ location: { latitude: 51.5063, longitude: -0.1172 } }).where(eq(spot.id, id("macba")));

    const { local, pages, cursor } = await pullAll(start, 2);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.slice(0, -1).every((page) => page.hasMore && page.items.length + page.tombstones.length === 2)).toBe(true);
    expect(cursor).toBe(await latestVersion());

    const ours = [...local.values()].filter((row) => row.id.startsWith(`e2e-${tag}-`));
    expect(ours.map((row) => row.id).sort()).toEqual([id("macba"), id("undercroft")]);
    expect(local.get(id("undercroft"))).toMatchObject({
      ...southbank,
      cityId,
      kind: "plaza",
      cover: { key: `spots/${tag}/0.jpg`, width: 1200, height: 900 },
      obstacles: ["ledges", "banks"],
    });
    expect(local.get(id("macba"))).toMatchObject({ cityId, cover: null, obstacles: [] });

    const idle = await read(SyncPageSchema, `/v1/sync/spots?cursor=${cursor}`, { headers: rider.bearer });
    expect(idle).toEqual({ items: [], tombstones: [], nextCursor: cursor, hasMore: false, resetRequired: false });
  });

  test("a fresh install (cursor 0) gets the published spots and no tombstones", async () => {
    const first = await read(SyncPageSchema, "/v1/sync/spots?cursor=0", { headers: rider.bearer });
    expect(first.tombstones).toEqual([]);
    const { local } = await pullAll(0, 500);
    expect(local.has(id("nextdoor"))).toBe(false);
    expect(local.has(id("undercroft"))).toBe(true);
  });

  test("a cursor this server never issued asks for a re-index", async () => {
    const page = await read(SyncPageSchema, `/v1/sync/spots?cursor=${(await latestVersion()) + 1000}`, { headers: rider.bearer });
    expect(page).toMatchObject({ items: [], resetRequired: true, nextCursor: 0 });
  });

  test("details come back for published spots; the rest are missing", async () => {
    const ids = [id("undercroft"), id("nextdoor"), id("nope"), id("undercroft")].join(",");
    const { spots, missing } = await read(SpotDetailsSchema, `/v1/spots?ids=${ids}`, { headers: rider.bearer });
    expect(spots).toHaveLength(1);
    expect(spots[0]).toMatchObject({
      id: id("undercroft"),
      title: "Southbank Undercroft",
      obstacles: ["ledges", "banks"],
      addedBy: { id: rider.userId, name: "Undercroft Local" },
      photos: [{ id: id("photo-0"), position: 0, credit: "Undercroft Local" }, { id: id("photo-1"), position: 1, credit: "@someone" }],
    });
    expect(missing.sort()).toEqual([id("nextdoor"), id("nope")].sort());
  });

  test("nearby finds published spots within the radius, nearest first", async () => {
    const { spots } = await read(
      z.object({ spots: z.array(NearbySpotSchema) }),
      `/v1/spots/nearby?latitude=${southbank.latitude}&longitude=${southbank.longitude}&radiusMeters=100`,
      { headers: rider.bearer },
    );
    const ours = spots.filter((row) => row.id.startsWith(`e2e-${tag}-`));
    expect(ours.map((row) => row.id)).toEqual([id("undercroft"), id("macba")]);
    expect(ours[0]!.distanceMeters).toBe(0);
    expect(ours[1]!.distanceMeters).toBeGreaterThan(20);
    expect(ours[1]!.distanceMeters).toBeLessThan(60);
  });

  test("cities come with their bounds", async () => {
    const { cities } = await read(z.object({ cities: z.array(CitySchema) }), "/v1/cities", { headers: rider.bearer });
    expect(cities.find((row) => row.id === cityId)).toEqual({
      id: cityId,
      slug: `e2e-${tag}`,
      name: `E2E Southbank ${tag}`,
      countryCode: "GB",
      bounds: { minLatitude: 51.5, minLongitude: -0.125, maxLatitude: 51.51, maxLongitude: -0.105 },
    });
  });

  test("malformed queries are refused", async () => {
    const refused = await Promise.all(
      ["/v1/spots?ids=", "/v1/spots?ids=a,b%20c", "/v1/sync/spots?limit=0", "/v1/sync/spots?cursor=1.5", "/v1/spots/nearby?latitude=abc&longitude=0", "/v1/spots/nearby?latitude=&longitude=0"].map(
        async (path) => `${path} -> ${(await call(path, { headers: rider.bearer })).status}`,
      ),
    );
    expect(refused).toEqual(refused.map((line) => `${line.split(" -> ")[0]} -> 422`));
  });

  test("a writer waits for an earlier one to commit, so versions follow commit order", async () => {
    const [other, observer] = await Promise.all([openDatabase(e2eUrl!), openDatabase(e2eUrl!)]);
    try {
      let release = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      let inserted = () => {};
      const firstInserted = new Promise<void>((resolve) => (inserted = resolve));
      const first = db.transaction(async (tx) => {
        await tx.insert(spot).values({ id: id("first"), title: "First", kind: "street", location: macba });
        inserted();
        await held;
      });
      await firstInserted;
      const second = other.db.insert(spot).values({ id: id("second"), title: "Second", kind: "street", location: macba }).execute();

      const waiting = async () =>
        Number((await observer.db.execute(sql`select count(*) as n from pg_locks where locktype = 'advisory' and not granted`)).rows[0]?.n ?? 0);
      let parked = 0;
      try {
        for (let attempt = 0; attempt < 100 && parked === 0; attempt += 1) {
          parked = await waiting();
          if (parked === 0) await Bun.sleep(10);
        }
      } finally {
        release();
      }
      await Promise.all([first, second]);
      expect(parked).toBe(1);
      const versions = await db.select({ id: spot.id, version: spot.version }).from(spot).where(inArray(spot.id, [id("first"), id("second")]));
      const byId = Object.fromEntries(versions.map((row) => [row.id, row.version]));
      expect(byId[id("second")]!).toBeGreaterThan(byId[id("first")]!);
    } finally {
      await Promise.all([other.close(), observer.close()]);
    }
  });
});
