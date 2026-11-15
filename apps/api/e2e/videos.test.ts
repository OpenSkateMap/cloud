import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Database, openDatabase, schema } from "@openskatemap/db";
import { eq, inArray, sql } from "drizzle-orm";
import { SpotDetailsSchema } from "../src/lib/spot-schemas.ts";
import { ReviewQueueSchema } from "../src/lib/submission-schemas.ts";
import { VideoSubmissionSchema } from "../src/lib/video-schemas.ts";
import { call, createRider, e2eUrl, read } from "./support.ts";

const { city, cityEditor, reviewEvent, spot, spotVideo, user, userBlock } = schema;

type Rider = Awaited<ReturnType<typeof createRider>>;

describe.skipIf(!e2eUrl)("spot videos (database)", () => {
  const database = e2eUrl ? openDatabase(e2eUrl) : undefined;
  const tag = crypto.randomUUID().slice(0, 8);
  const cityA = { id: `e2e-city-${tag}-a`, slug: `e2e-${tag}-a` };
  const cityB = { id: `e2e-city-${tag}-b`, slug: `e2e-${tag}-b` };
  const spotA = `e2e-spot-${tag}-a`;
  const spotB = `e2e-spot-${tag}-b`;
  const ids = {
    first: crypto.randomUUID(),
    clash: crypto.randomUUID(),
    again: crypto.randomUUID(),
    inB: crypto.randomUUID(),
    gone: crypto.randomUUID(),
  };
  const realFetch = globalThis.fetch;
  const goneOnYouTube = new Set(["aaaaaaaaaaa"]);
  const fakeYouTube = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host !== "www.youtube.com" || url.pathname !== "/oembed") return realFetch(input, init);
    const id = new URL(url.searchParams.get("url") ?? "").searchParams.get("v") ?? "";
    return new Response(goneOnYouTube.has(id) ? "Bad Request" : JSON.stringify({ title: id }), { status: goneOnYouTube.has(id) ? 400 : 200 });
  }) as typeof fetch;
  let db: Database;
  let submitter: Rider, editorA: Rider, editorB: Rider, admin: Rider, plain: Rider;

  const json = (as: Rider, method: string, body: unknown) => ({
    method,
    headers: { ...as.bearer, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const send = (videoId: string, url: string, as: Rider = submitter, spotId = spotA, caption?: string) =>
    call(`/v1/spots/${spotId}/videos/${videoId}`, json(as, "PUT", { url, ...(caption === undefined ? {} : { caption }) }));
  const seen = async (videoId: string) =>
    (await db.select({ updatedAt: spotVideo.updatedAt }).from(spotVideo).where(eq(spotVideo.id, videoId)))[0]!.updatedAt.toISOString();
  const decide = async (action: "approve" | "reject", videoId: string, as: Rider, body: Record<string, unknown> = {}) =>
    call(`/v1/review/videos/${videoId}/${action}`, json(as, "POST", { seenUpdatedAt: await seen(videoId), ...body }));
  const undo = (videoId: string, as: Rider) => call(`/v1/review/videos/${videoId}/undo`, json(as, "POST", {}));
  const queuedVideos = async (as: Rider) =>
    ReviewQueueSchema.parse((await call("/v1/review/queue?limit=50", { headers: as.bearer })).body.data)
      .videos.map((video) => video.id)
      .filter((id) => Object.values(ids).includes(id))
      .sort();
  const versionOf = async (spotId: string) => (await db.select({ version: spot.version }).from(spot).where(eq(spot.id, spotId)))[0]!.version;
  const detail = async (as: Rider) => (await read(SpotDetailsSchema, `/v1/spots?ids=${spotA}`, { headers: as.bearer })).spots[0]!;

  beforeAll(async () => {
    globalThis.fetch = fakeYouTube;
    db = (await database!).db;
    [submitter, editorA, editorB, admin, plain] = [
      await createRider(db, "Submitter"),
      await createRider(db, "Editor A"),
      await createRider(db, "Editor B"),
      await createRider(db, "Admin"),
      await createRider(db, "Plain"),
    ];
    await db.update(user).set({ role: "editor" }).where(inArray(user.id, [editorA.userId, editorB.userId]));
    await db.update(user).set({ role: "admin" }).where(eq(user.id, admin.userId));
    await db.insert(city).values([
      { ...cityA, name: `E2E A ${tag}`, countryCode: "GB", area: sql`ST_Multi(ST_MakeEnvelope(-0.125, 51.50, -0.105, 51.51, 4326))` },
      { ...cityB, name: `E2E B ${tag}`, countryCode: "ES", area: sql`ST_Multi(ST_MakeEnvelope(2.13, 41.37, 2.15, 41.39, 4326))` },
    ]);
    await db.insert(cityEditor).values([
      { cityId: cityA.id, userId: editorA.userId },
      { cityId: cityB.id, userId: editorB.userId },
    ]);
    await db.insert(spot).values([
      { id: spotA, title: "Undercroft", kind: "plaza", location: { latitude: 51.5066, longitude: -0.1169 } },
      { id: spotB, title: "Sants", kind: "plaza", location: { latitude: 41.379, longitude: 2.1405 } },
    ]);
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await db.delete(spot).where(inArray(spot.id, [spotA, spotB]));
    await db.delete(city).where(inArray(city.id, [cityA.id, cityB.id]));
    await db.delete(user).where(inArray(user.id, [submitter, editorA, editorB, admin, plain].map((rider) => rider.userId)));
    await (await database!).close();
  });

  test("a link is checked, normalised and kept once per outbox id", async () => {
    const refused = await send(ids.first, "https://vimeo.com/123");
    expect([refused.status, refused.body.error?.code]).toEqual([422, "validation_failed"]);
    expect((await send(ids.first, "https://youtu.be/dQw4w9WgXcQ", submitter, "e2e-no-such-spot")).status).toBe(404);

    const sent = await send(ids.first, "https://youtu.be/dQw4w9WgXcQ?si=share&t=42", submitter, spotA, "  Kickflip by @local  ");
    expect(sent.status).toBe(200);
    expect(VideoSubmissionSchema.parse(sent.body.data)).toMatchObject({
      provider: "youtube",
      externalId: "dQw4w9WgXcQ",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s",
      startSeconds: 42,
      thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
      caption: "Kickflip by @local",
      status: "pending",
    });
    expect((await send(ids.first, "https://www.youtube.com/watch?v=dQw4w9WgXcQ")).status).toBe(200);
    expect(VideoSubmissionSchema.parse((await send(ids.first, "https://www.instagram.com/reel/C1aB2cD3eF4/")).body.data).provider).toBe("instagram");
    expect(VideoSubmissionSchema.parse((await send(ids.first, "https://youtu.be/dQw4w9WgXcQ")).body.data).startSeconds).toBeNull();
    expect(await db.$count(spotVideo, eq(spotVideo.id, ids.first))).toBe(1);

    expect((await send(ids.first, "https://youtu.be/dQw4w9WgXcQ", plain)).status).toBe(403);
    const clash = await send(ids.clash, "https://www.youtube.com/shorts/dQw4w9WgXcQ", plain);
    expect([clash.status, clash.body.error?.code]).toEqual([409, "conflict"]);
    expect((await send(ids.inB, "https://youtu.be/9bZkp7q19f0", submitter, spotB)).status).toBe(200);
  });

  test("a video YouTube no longer has is refused; one already stored isn't asked about again", async () => {
    const refused = await send(ids.gone, "https://youtu.be/aaaaaaaaaaa");
    expect([refused.status, refused.body.error?.code]).toEqual([422, "validation_failed"]);
    expect(await db.$count(spotVideo, eq(spotVideo.id, ids.gone))).toBe(0);

    expect((await send(ids.gone, "https://youtu.be/9bZkp7q19f0")).status).toBe(200);
    goneOnYouTube.add("9bZkp7q19f0");
    expect((await send(ids.gone, "https://youtu.be/9bZkp7q19f0")).status).toBe(200);
    goneOnYouTube.delete("9bZkp7q19f0");
    await db.delete(spotVideo).where(eq(spotVideo.id, ids.gone));
  });

  test("pending videos reach the reviewers of their spot's city", async () => {
    expect(await queuedVideos(plain)).toEqual([]);
    expect(await queuedVideos(editorA)).toEqual([ids.first]);
    expect(await queuedVideos(editorB)).toEqual([ids.inB]);
    expect(await queuedVideos(admin)).toEqual([ids.first, ids.inB].sort());
    const card = ReviewQueueSchema.parse((await call("/v1/review/queue?limit=50", { headers: editorA.bearer })).body.data).videos.find(
      (video) => video.id === ids.first,
    );
    expect(card).toMatchObject({ spot: { id: spotA, title: "Undercroft", kind: "plaza", cityId: cityA.id }, submitter: { id: submitter.userId, name: "Submitter" } });
  });

  test("approving shows the video on the spot and gives the spot a new version", async () => {
    const before = await versionOf(spotA);
    expect((await decide("approve", ids.first, editorB)).status).toBe(403);
    const approved = await decide("approve", ids.first, editorA);
    expect(approved.status).toBe(200);
    expect(VideoSubmissionSchema.parse(approved.body.data).status).toBe("approved");
    expect(await versionOf(spotA)).toBeGreaterThan(before);
    expect((await decide("approve", ids.first, editorA)).status).toBe(200);
    const late = await decide("reject", ids.first, admin, { reason: "duplicate" });
    expect([late.status, late.body.error?.code]).toEqual([409, "conflict"]);

    const shown = await detail(plain);
    expect(shown.videos.map((video) => [video.id, video.addedBy?.name])).toEqual([[ids.first, "Submitter"]]);
    await db.insert(userBlock).values({ blockerId: plain.userId, blockedId: submitter.userId });
    expect((await detail(plain)).videos[0]?.addedBy).toBeNull();
    expect(await queuedVideos(editorA)).toEqual([]);
  });

  test("an admin's undo takes a video down; a rejected clip may be sent again", async () => {
    const before = await versionOf(spotA);
    expect((await undo(ids.first, plain)).status).toBe(403);
    expect((await undo(ids.first, admin)).status).toBe(200);
    expect((await undo(ids.first, admin)).status).toBe(200);
    expect(await versionOf(spotA)).toBeGreaterThan(before);
    expect((await detail(plain)).videos).toEqual([]);

    const rejected = await decide("reject", ids.first, editorA, { reason: "wrong_spot" });
    expect(VideoSubmissionSchema.parse(rejected.body.data)).toMatchObject({ status: "rejected", rejectReason: "wrong_spot" });
    expect((await send(ids.again, "https://youtu.be/dQw4w9WgXcQ", plain)).status).toBe(200);

    const events = await db.select({ action: reviewEvent.action }).from(reviewEvent).where(eq(reviewEvent.videoId, ids.first)).orderBy(reviewEvent.id);
    expect(events.map((event) => event.action)).toEqual(["approve", "undo", "reject"]);
  });

  test("a video can be reported", async () => {
    const report = (targetId: string) => call("/v1/reports", json(plain, "POST", { targetKind: "video", targetId, reason: "inappropriate" }));
    expect((await report(ids.first)).status).toBe(200);
    expect((await report(crypto.randomUUID())).status).toBe(404);
  });
});
