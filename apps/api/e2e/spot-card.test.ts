import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Database, openDatabase, schema } from "@openskatemap/db";
import { eq, sql } from "drizzle-orm";
import { SpotCardSchema } from "../src/lib/spot-schemas.ts";
import { call, createRider, e2eUrl } from "./support.ts";

const { city, spot, spotPhoto, user } = schema;

describe.skipIf(!e2eUrl)("spot card (database)", () => {
  const database = e2eUrl ? openDatabase(e2eUrl) : undefined;
  const tag = crypto.randomUUID().slice(0, 8);
  const cityId = `e2e-card-city-${tag}`;
  const id = (name: string) => `e2e-card-${tag}-${name}`;
  const undercroft = { latitude: 51.5065, longitude: -0.1167 };
  let db: Database;
  let rider: Awaited<ReturnType<typeof createRider>>;

  beforeAll(async () => {
    db = (await database!).db;
    rider = await createRider(db, "Card Local");
    await db.insert(city).values({
      id: cityId,
      slug: `e2e-card-${tag}`,
      name: `Card City ${tag}`,
      countryCode: "GB",
      area: sql`ST_Multi(ST_MakeEnvelope(-0.125, 51.50, -0.105, 51.51, 4326))`,
    });
    await db.insert(spot).values({
      id: id("covered"),
      title: "Southbank Undercroft",
      description: "Under the Queen Elizabeth Hall; ask the locals before filming.",
      kind: "plaza",
      obstacles: ["ledges", "banks"],
      location: undercroft,
      createdBy: rider.userId,
    });
    await db.insert(spotPhoto).values({ id: id("cover"), spotId: id("covered"), r2Key: `photos/${tag}-0.jpg`, width: 1600, height: 1200, thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI", credit: "@local", uploadedBy: rider.userId, hasPermission: true, position: 0 });
    await db.insert(spotPhoto).values({ id: id("second"), spotId: id("covered"), r2Key: `photos/${tag}-1.jpg`, width: 1200, height: 1600, thumbhash: "2QcSHQRnh493V4dIh4eXh1h4kJUI", credit: null, uploadedBy: rider.userId, hasPermission: true, position: 1 });
    await db.insert(spot).values({ id: id("bare"), title: "Somewhere at Sea", kind: "street", location: { latitude: 0.5, longitude: -30.5 } });
    await db.insert(spot).values({ id: id("removed"), title: "Gone Ledge", kind: "street", location: undercroft, status: "removed" });
  });

  afterAll(async () => {
    await db.delete(spot).where(sql`${spot.id} like ${`e2e-card-${tag}-%`}`);
    await db.delete(city).where(eq(city.id, cityId));
    await db.delete(user).where(eq(user.id, rider.userId));
    await (await database!).close();
  });

  test("anyone gets a published spot's card without signing in: name, kind, city, cover and version, nothing else", async () => {
    const { status, body } = await call(`/v1/spots/${id("covered")}/card`);
    expect(status).toBe(200);
    const [stored] = await db.select({ version: spot.version }).from(spot).where(eq(spot.id, id("covered")));
    expect(body.data).toEqual({
      id: id("covered"),
      title: "Southbank Undercroft",
      kind: "plaza",
      city: `Card City ${tag}`,
      cover: { key: `photos/${tag}-0.jpg`, width: 1600, height: 1200, thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI" },
      version: stored!.version,
    });
    expect(SpotCardSchema.parse(body.data)).toEqual(body.data as never);
    const text = JSON.stringify(body);
    for (const leak of ["latitude", "longitude", "51.5", "-0.11", "Queen Elizabeth", "ledges", "@local", "Card Local", rider.userId]) {
      expect(text).not.toContain(leak);
    }
  });

  test("a spot without a photo or a city still has a card", async () => {
    const { status, body } = await call(`/v1/spots/${id("bare")}/card`);
    expect(status).toBe(200);
    expect(body.data).toMatchObject({ id: id("bare"), title: "Somewhere at Sea", kind: "street", city: null, cover: null });
  });

  test("removed and unknown spots are not found", async () => {
    for (const missing of [id("removed"), id("nope")]) {
      const { status, body } = await call(`/v1/spots/${missing}/card`);
      expect(status).toBe(404);
      expect(body.error?.code).toBe("not_found");
    }
  });

  test("a card may be cached for a few minutes, found or not", async () => {
    const { createApp } = await import("../src/app.ts");
    const { bindings, executionContext } = await import("../test/support.ts");
    for (const spotId of [id("covered"), id("nope")]) {
      const response = await createApp().request(`/v1/spots/${spotId}/card`, {}, bindings({ HYPERDRIVE: { connectionString: e2eUrl } }), executionContext().ctx);
      expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    }
  });
});
