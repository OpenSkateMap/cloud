import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Database, openDatabase, schema } from "@openskatemap/db";
import { and, eq, inArray } from "drizzle-orm";
import { SpotDetailsSchema, SpotVotesSchema } from "../src/lib/spot-schemas.ts";
import { call, createRider, e2eUrl, read } from "./support.ts";

const { spot, spotVote, user } = schema;

type Rider = Awaited<ReturnType<typeof createRider>>;

describe.skipIf(!e2eUrl)("spot votes (database)", () => {
  const database = e2eUrl ? openDatabase(e2eUrl) : undefined;
  const tag = crypto.randomUUID().slice(0, 8);
  const spotA = `e2e-spot-${tag}-a`;
  const spotB = `e2e-spot-${tag}-b`;
  const removed = `e2e-spot-${tag}-removed`;
  let db: Database;
  let first: Rider, second: Rider, leaving: Rider;

  const vote = (value: number, as: Rider, spotId = spotA) =>
    call(`/v1/spots/${spotId}/vote`, {
      method: "PUT",
      headers: { ...as.bearer, "content-type": "application/json" },
      body: JSON.stringify({ value }),
    });
  const votes = async (value: number, as: Rider, spotId = spotA) => {
    const { status, body } = await vote(value, as, spotId);
    expect(status).toBe(200);
    return SpotVotesSchema.parse(body.data);
  };
  const details = async (as: Rider) =>
    Object.fromEntries(
      (await read(SpotDetailsSchema, `/v1/spots?ids=${spotA},${spotB}`, { headers: as.bearer })).spots.map((detail) => [detail.id, detail.votes]),
    );
  const versionOf = async (spotId: string) => (await db.select({ version: spot.version }).from(spot).where(eq(spot.id, spotId)))[0]!.version;

  beforeAll(async () => {
    db = (await database!).db;
    [first, second, leaving] = [await createRider(db, "First"), await createRider(db, "Second"), await createRider(db, "Leaving")];
    await db.insert(spot).values([
      { id: spotA, title: "Undercroft", kind: "plaza", location: { latitude: 51.5066, longitude: -0.1169 } },
      { id: spotB, title: "Sants", kind: "plaza", location: { latitude: 41.379, longitude: 2.1405 } },
      { id: removed, title: "Gone", kind: "street", status: "removed", location: { latitude: 41.38, longitude: 2.14 } },
    ]);
  });

  afterAll(async () => {
    await db.delete(spot).where(inArray(spot.id, [spotA, spotB, removed]));
    await db.delete(user).where(inArray(user.id, [first, second, leaving].map((rider) => rider.userId)));
    await (await database!).close();
  });

  test("analytics count each real change of a vote once, however often it's resent", async () => {
    const realFetch = globalThis.fetch;
    const events: string[] = [];
    globalThis.fetch = (async (url: URL | RequestInfo, init?: RequestInit) => {
      if (!String(url).startsWith("https://us.i.posthog.com/")) return realFetch(url, init);
      const sent = JSON.parse(String(init?.body)) as { event: string; uuid: string };
      events.push(`${sent.event}:${sent.uuid}`);
      return new Response("{}");
    }) as typeof fetch;
    const voter = await createRider(db, "Counted");
    try {
      for (const value of [1, 1, 0, 0, 1]) {
        const { status } = await call(
          `/v1/spots/${spotB}/vote`,
          { method: "PUT", headers: { ...voter.bearer, "content-type": "application/json" }, body: JSON.stringify({ value }) },
          { POSTHOG_PROJECT_TOKEN: "phc_e2e" },
        );
        expect(status).toBe(200);
      }
      expect(events).toHaveLength(3);
      expect(new Set(events).size).toBe(3);
    } finally {
      globalThis.fetch = realFetch;
      await db.delete(user).where(eq(user.id, voter.userId));
    }
  });

  test("a vote needs a session", async () => {
    const { status, body } = await call(`/v1/spots/${spotA}/vote`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: 1 }),
    });
    expect([status, body.error?.code]).toEqual([401, "auth_required"]);
  });

  test("only published spots take votes, and only -1, 0 or 1", async () => {
    expect((await vote(1, first, removed)).status).toBe(404);
    expect((await vote(1, first, `e2e-no-such-spot-${tag}`)).status).toBe(404);
    const refused = await vote(2, first);
    expect([refused.status, refused.body.error?.code]).toEqual([422, "validation_failed"]);
    expect(await db.select().from(spotVote).where(inArray(spotVote.spotId, [spotA, removed]))).toEqual([]);
  });

  test("one vote per rider: voting again is a no-op, changing it moves the totals, 0 clears it", async () => {
    const version = await versionOf(spotA);
    expect(await votes(1, first)).toEqual({ up: 1, down: 0, mine: 1 });
    const stored = async () =>
      (await db.select({ updatedAt: spotVote.updatedAt }).from(spotVote).where(and(eq(spotVote.spotId, spotA), eq(spotVote.userId, first.userId))))[0]!
        .updatedAt;
    const firstWrite = await stored();
    expect(await votes(1, first)).toEqual({ up: 1, down: 0, mine: 1 });
    expect(await stored()).toEqual(firstWrite);

    expect(await votes(-1, second)).toEqual({ up: 1, down: 1, mine: -1 });
    expect(await votes(-1, first)).toEqual({ up: 0, down: 2, mine: -1 });
    expect(await votes(0, first)).toEqual({ up: 0, down: 1, mine: 0 });
    expect(await votes(0, first)).toEqual({ up: 0, down: 1, mine: 0 });
    expect(await votes(1, first)).toEqual({ up: 1, down: 1, mine: 1 });

    expect(await versionOf(spotA)).toBe(version);
  });

  test("details carry each spot's totals and the viewer's own vote", async () => {
    expect(await details(first)).toEqual({
      [spotA]: { up: 1, down: 1, mine: 1 },
      [spotB]: { up: 0, down: 0, mine: 0 },
    });
    expect(await details(second)).toEqual({
      [spotA]: { up: 1, down: 1, mine: -1 },
      [spotB]: { up: 0, down: 0, mine: 0 },
    });
  });

  test("deleting an account takes its votes with it", async () => {
    expect(await votes(1, leaving)).toEqual({ up: 2, down: 1, mine: 1 });
    expect(await votes(-1, leaving, spotB)).toEqual({ up: 0, down: 1, mine: -1 });
    expect((await call("/v1/me", { method: "DELETE", headers: leaving.bearer })).status).toBe(200);
    expect(await db.select().from(spotVote).where(eq(spotVote.userId, leaving.userId))).toEqual([]);
    expect(await details(first)).toEqual({
      [spotA]: { up: 1, down: 1, mine: 1 },
      [spotB]: { up: 0, down: 0, mine: 0 },
    });
  });

});
