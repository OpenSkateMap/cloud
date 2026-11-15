import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Database, openDatabase, schema } from "@openskatemap/db";
import { inArray, sql } from "drizzle-orm";
import { SpotScoresSchema } from "../src/lib/spot-schemas.ts";
import { refreshSpotScores } from "../src/services/spot-score.ts";
import { call, createRider, e2eUrl } from "./support.ts";

const { city, spot, spotPhoto, spotVideo, spotVote, user } = schema;

type Rider = Awaited<ReturnType<typeof createRider>>;

describe.skipIf(!e2eUrl)("spot score (database)", () => {
  const database = e2eUrl ? openDatabase(e2eUrl) : undefined;
  const tag = crypto.randomUUID().slice(0, 8);
  const home = { id: `e2e-city-${tag}-home`, slug: `e2e-${tag}-home` };
  const away = { id: `e2e-city-${tag}-away`, slug: `e2e-${tag}-away` };
  const ids = {
    star: `e2e-score-${tag}-star`,
    oneUp: `e2e-score-${tag}-one-up`,
    manyUp: `e2e-score-${tag}-many-up`,
    demolished: `e2e-score-${tag}-demolished`,
    quiet: `e2e-score-${tag}-quiet`,
    hidden: `e2e-score-${tag}-private`,
    removed: `e2e-score-${tag}-removed`,
  };
  let db: Database;
  let plain: Rider;
  const voters: Rider[] = [];

  beforeAll(async () => {
    db = (await database!).db;
    plain = await createRider(db, "Plain");
    for (let index = 0; index < 13; index++) voters.push(await createRider(db, `Voter ${index}`));
    await db.insert(city).values([
      { ...home, name: `E2E Home ${tag}`, countryCode: "PT", area: sql`ST_Multi(ST_MakeEnvelope(-9.20, 38.70, -9.10, 38.75, 4326))` },
      { ...away, name: `E2E Away ${tag}`, countryCode: "PT", area: sql`ST_Multi(ST_MakeEnvelope(-8.65, 41.13, -8.58, 41.17, 4326))` },
    ]);
    const at = (offset: number) => ({ latitude: 38.72 + offset / 1000, longitude: -9.15 });
    await db.insert(spot).values([
      { id: ids.star, title: "Star", kind: "plaza", location: at(1) },
      { id: ids.oneUp, title: "One Up", kind: "street", location: at(2) },
      { id: ids.manyUp, title: "Many Up", kind: "street", location: at(3) },
      { id: ids.demolished, title: "Gone Soon", kind: "plaza", condition: "demolished", location: at(4) },
      { id: ids.quiet, title: "Quiet", kind: "street", location: at(5) },
      { id: ids.hidden, title: "Backyard", kind: "diy", visibility: "private", createdBy: plain.userId, location: at(6) },
      { id: ids.removed, title: "Removed", kind: "street", status: "removed", location: at(7) },
    ]);
    const photo = (spotId: string, position: number) => ({
      id: crypto.randomUUID(),
      spotId,
      r2Key: `photos/${crypto.randomUUID()}.jpg`,
      width: 640,
      height: 480,
      thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI",
      hasPermission: false,
      position,
    });
    await db.insert(spotPhoto).values([0, 1, 2].map((position) => photo(ids.star, position)));
    await db.insert(spotPhoto).values([0, 1, 2, 3, 4].map((position) => photo(ids.demolished, position)));
    await db.insert(spotVideo).values({
      id: crypto.randomUUID(),
      spotId: ids.star,
      provider: "youtube",
      externalId: `e2e${tag}`,
      url: `https://www.youtube.com/watch?v=e2e${tag}`,
      status: "approved",
      reviewedAt: new Date(),
    });
    await db.insert(spotVote).values([
      { spotId: ids.oneUp, userId: voters[0]!.userId, value: 1 },
      ...voters.slice(0, 12).map((voter) => ({ spotId: ids.manyUp, userId: voter.userId, value: 1 })),
      { spotId: ids.manyUp, userId: voters[12]!.userId, value: -1 },
      { spotId: ids.hidden, userId: voters[0]!.userId, value: 1 },
      { spotId: ids.removed, userId: voters[0]!.userId, value: 1 },
    ]);
  });

  afterAll(async () => {
    await db.delete(spot).where(inArray(spot.id, Object.values(ids)));
    await db.delete(city).where(inArray(city.id, [home.id, away.id]));
    await db.delete(user).where(inArray(user.id, [plain, ...voters].map((rider) => rider.userId)));
    await (await database!).close();
  });

  test("every public spot has a score on 0…1: spots with media lead, one vote can't beat many, demolished sinks", async () => {
    const anonymous = await call("/v1/spot-scores");
    expect([anonymous.status, anonymous.body.error?.code]).toEqual([401, "auth_required"]);
    const beforeRefresh = SpotScoresSchema.parse((await call("/v1/spot-scores", { headers: plain.bearer })).body.data).items;
    expect(beforeRefresh.some((item) => item.spotId === ids.star)).toBe(false);
    await refreshSpotScores(db);
    const { status, headers, body } = await call("/v1/spot-scores", { headers: plain.bearer });
    expect([status, headers.get("cache-control")]).toEqual([200, "private, max-age=60"]);
    const items = SpotScoresSchema.parse(body.data).items;
    const scores = new Map(items.map(({ spotId, ...score }) => [spotId, score]));

    expect(items.map((item) => item.score)).toEqual(items.map((item) => item.score).toSorted((a, b) => b - a));
    for (const item of items) expect(item.score).toBeWithin(0, 1.0001);
    for (const absent of [ids.hidden, ids.removed]) expect(scores.has(absent)).toBe(false);

    const score = (id: string) => scores.get(id)!.score;
    expect(scores.get(ids.manyUp)).toMatchObject({ up: 12, down: 1 });
    expect(scores.get(ids.quiet)).toMatchObject({ up: 0, down: 0 });
    expect(score(ids.star)).toBeGreaterThan(score(ids.oneUp));
    expect(score(ids.manyUp)).toBeGreaterThan(score(ids.oneUp));
    expect(score(ids.oneUp)).toBeGreaterThan(score(ids.quiet));
    expect(score(ids.demolished)).toBeLessThan(0.1);
  });
});
