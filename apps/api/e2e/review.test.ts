import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Database, openDatabase, schema } from "@openskatemap/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { SyncPageSchema } from "../src/lib/spot-schemas.ts";
import { ReviewQueueSchema, SubmissionSchema } from "../src/lib/submission-schemas.ts";
import { call, createRider, e2eUrl, read } from "./support.ts";

const { city, cityEditor, photoUpload, reviewEvent, spot, spotPhoto, submission, user } = schema;

const segment = (marker: number, payload: number[]) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
const jpeg = new Uint8Array([0xff, 0xd8, ...segment(0xc0, [8, 0x01, 0xe0, 0x02, 0x80, 1, 1, 0x11, 0]), 0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, 0x12, 0xff, 0xd9]);
const thumbhash = "1QcSHQRnh493V4dIh4eXh1h4kJUI";

type Rider = Awaited<ReturnType<typeof createRider>>;

describe.skipIf(!e2eUrl)("review (database)", () => {
  const database = e2eUrl ? openDatabase(e2eUrl) : undefined;
  const tag = crypto.randomUUID().slice(0, 8);
  const southbank = { id: `e2e-city-${tag}-a`, slug: `e2e-${tag}-a` };
  const sants = { id: `e2e-city-${tag}-b`, slug: `e2e-${tag}-b` };
  let db: Database;
  let submitter: Rider, editorA: Rider, editorB: Rider, admin: Rider, plain: Rider;
  const photoIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const ids = { inA: crypto.randomUUID(), alsoInA: crypto.randomUUID(), nowhere: crypto.randomUUID(), byAdmin: crypto.randomUUID() };
  const spotIds: string[] = [];

  const post = (path: string, as: Rider, body: unknown = {}) =>
    call(path, { method: "POST", headers: { ...as.bearer, "content-type": "application/json" }, body: JSON.stringify(body) });
  const queue = (as: Rider, query = "") => call(`/v1/review/queue${query}`, { headers: as.bearer });
  const seen = async (submissionId: string) =>
    (await db.select({ updatedAt: submission.updatedAt }).from(submission).where(eq(submission.id, submissionId)))[0]!.updatedAt.toISOString();
  const decide = async (action: "approve" | "reject", submissionId: string, as: Rider, body: Record<string, unknown> = {}) =>
    post(`/v1/review/${submissionId}/${action}`, as, { seenUpdatedAt: await seen(submissionId), ...body });
  const ours = (items: { id: string }[]) => items.map((item) => item.id).filter((id) => Object.values(ids).includes(id)).sort();

  async function makeEditor(rider: Rider, cityId: string) {
    await db.update(user).set({ role: "editor" }).where(eq(user.id, rider.userId));
    await db.insert(cityEditor).values({ cityId, userId: rider.userId });
  }

  async function submitAt(submissionId: string, latitude: number, longitude: number) {
    const body = {
      kind: "new_spot",
      title: "Ledge spot",
      spotKind: "street",
      latitude,
      longitude,
      photos: [
        { photoId: photoIds[0], thumbhash, credit: { takenBy: "submitter" } },
        { photoId: photoIds[1], thumbhash, credit: { takenBy: "someone_else", credit: "@lens", hasPermission: true } },
      ],
    };
    const { status } = await call(`/v1/submissions/${submissionId}`, {
      method: "PUT",
      headers: { ...submitter.bearer, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(status).toBe(200);
  }

  beforeAll(async () => {
    db = (await database!).db;
    [submitter, editorA, editorB, admin, plain] = [
      await createRider(db, "Submitter"),
      await createRider(db, "Editor A"),
      await createRider(db, "Editor B"),
      await createRider(db, "Admin"),
      await createRider(db, "Plain"),
    ];
    await db.update(user).set({ role: "admin" }).where(eq(user.id, admin.userId));
    await db.insert(city).values([
      { ...southbank, name: `E2E A ${tag}`, countryCode: "GB", area: sql`ST_Multi(ST_MakeEnvelope(-0.125, 51.50, -0.105, 51.51, 4326))` },
      { ...sants, name: `E2E B ${tag}`, countryCode: "ES", area: sql`ST_Multi(ST_MakeEnvelope(2.13, 41.37, 2.15, 41.39, 4326))` },
    ]);
    await makeEditor(editorA, southbank.id);
    await makeEditor(editorB, sants.id);
    for (const [index, photoId] of photoIds.entries()) {
      const uploader = index === 2 ? admin : submitter;
      await call(`/v1/photos/${photoId}`, { method: "PUT", headers: { ...uploader.bearer, "content-type": "image/jpeg" }, body: jpeg });
    }
    await submitAt(ids.inA, 51.5066, -0.1169);
    await submitAt(ids.alsoInA, 51.505, -0.115);
    await submitAt(ids.nowhere, -80, 0);
  });

  afterAll(async () => {
    await db.delete(submission).where(inArray(submission.id, Object.values(ids)));
    if (spotIds.length > 0) await db.delete(spot).where(inArray(spot.id, spotIds));
    await db.delete(photoUpload).where(inArray(photoUpload.id, photoIds));
    await db.delete(city).where(inArray(city.id, [southbank.id, sants.id]));
    await db.delete(user).where(inArray(user.id, [submitter, editorA, editorB, admin, plain].map((rider) => rider.userId)));
    await (await database!).close();
  });

  test("a new spot's card lists the published spots within 150 m, nearest first", async () => {
    const twin = `e2e-spot-${tag}-twin`;
    await db.insert(spot).values({ id: twin, title: "Twin", kind: "street", location: { latitude: 51.505, longitude: -0.115 } });
    try {
      const card = ReviewQueueSchema.parse((await queue(editorA)).body.data).items.find((item) => item.id === ids.alsoInA)!;
      expect(card.nearby[0]).toEqual({ id: twin, title: "Twin", kind: "street", latitude: 51.505, longitude: -0.115, distanceMeters: 0 });
      expect(card.current).toBeNull();
    } finally {
      await db.delete(spot).where(eq(spot.id, twin));
    }
  });

  test("each reviewer sees the queue for their own cities; admins see everything", async () => {
    const nobody = ReviewQueueSchema.parse((await queue(plain)).body.data);
    expect([nobody.cityIds, ours(nobody.items)]).toEqual([[], []]);

    const a = ReviewQueueSchema.parse((await queue(editorA)).body.data);
    expect(a.cityIds).toEqual([southbank.id]);
    expect(ours(a.items)).toEqual([ids.inA, ids.alsoInA].sort());
    const card = a.items.find((item) => item.id === ids.inA)!;
    expect(card.submitter).toEqual({ id: submitter.userId, name: "Submitter" });
    expect(card.photos.map((photo) => photo.credit.takenBy)).toEqual(["submitter", "someone_else"]);
    expect(card.reviewAs).toBe("curator");

    expect(ours(ReviewQueueSchema.parse((await queue(editorB)).body.data).items)).toEqual([]);
    const everything = ReviewQueueSchema.parse((await queue(admin, "?limit=50")).body.data);
    expect(everything.cityIds).toBeNull();
    expect(ours(everything.items)).toContain(ids.nowhere);

    expect(ours(ReviewQueueSchema.parse((await queue(editorA, `?cityId=${sants.id}`)).body.data).items)).toEqual([]);
  });

  test("approving publishes the spot with the reviewer's edits, once", async () => {
    const [{ cursor } = { cursor: 0 }] = await db.select({ cursor: sql<number>`coalesce(max(${spot.version}), 0)`.mapWith(Number) }).from(spot);
    const approved = await decide("approve", ids.inA, editorA, {
      edits: { title: "Undercroft Ledges", obstacles: ["Ledges"], photoIds: [photoIds[1], photoIds[0]] },
    });
    expect(approved.status).toBe(200);
    const decided = SubmissionSchema.parse(approved.body.data);
    expect(decided).toMatchObject({ status: "approved", rejectReason: null });
    spotIds.push(decided.spotId!);

    const [published] = await db.select().from(spot).where(eq(spot.id, decided.spotId!));
    expect(published).toMatchObject({ status: "published", title: "Undercroft Ledges", obstacles: ["ledges"], cityId: southbank.id, createdBy: submitter.userId, approvedBy: editorA.userId });
    const photos = await db.select().from(spotPhoto).where(eq(spotPhoto.spotId, decided.spotId!)).orderBy(spotPhoto.position);
    expect(photos.map((photo) => [photo.credit, photo.uploadedBy])).toEqual([["@lens", submitter.userId], [null, submitter.userId]]);

    const page = await read(SyncPageSchema, `/v1/sync/spots?cursor=${cursor}`, { headers: plain.bearer });
    expect(page.items.find((row) => row.id === decided.spotId)).toMatchObject({ title: "Undercroft Ledges", cover: { width: 640, height: 480 } });

    expect((await decide("approve", ids.inA, editorA)).status).toBe(200);
    expect((await decide("approve", ids.inA, editorB)).status).toBe(403);
    const late = await decide("reject", ids.inA, admin, { reason: "duplicate" });
    expect([late.status, late.body.error?.code]).toEqual([409, "conflict"]);
    const events = await db
      .select({ action: reviewEvent.action, actorId: reviewEvent.actorId, as: sql<string>`${reviewEvent.details}->>'as'` })
      .from(reviewEvent)
      .where(eq(reviewEvent.submissionId, ids.inA));
    expect(events).toEqual([{ action: "approve", actorId: editorA.userId, as: "curator" }]);
  });

  test("an editor can't move a pin out of their cities, or publish photos from elsewhere", async () => {
    const moved = await decide("approve", ids.alsoInA, editorA, { edits: { latitude: 41.38, longitude: 2.14 } });
    expect([moved.status, moved.body.error?.code]).toEqual([403, "forbidden"]);
    const foreign = await decide("approve", ids.alsoInA, editorA, { edits: { photoIds: [crypto.randomUUID()] } });
    expect(foreign.status).toBe(422);
    const halfMove = await decide("approve", ids.alsoInA, editorA, { edits: { latitude: 51.5 } });
    expect(halfMove.status).toBe(422);
    const [row] = await db.select({ status: submission.status }).from(submission).where(eq(submission.id, ids.alsoInA));
    expect(row?.status).toBe("pending");
  });

  test("a decision is about the version the reviewer saw", async () => {
    const before = await seen(ids.alsoInA);
    await submitAt(ids.alsoInA, 51.505, -0.115);
    const late = await post(`/v1/review/${ids.alsoInA}/approve`, editorA, { seenUpdatedAt: before });
    expect([late.status, late.body.error?.code]).toEqual([409, "conflict"]);
    expect((await post(`/v1/review/${ids.alsoInA}/approve`, editorA, {})).status).toBe(422);
  });

  test("rejecting tells the submitter why", async () => {
    const rejected = await decide("reject", ids.alsoInA, editorA, { reason: "duplicate" });
    expect(SubmissionSchema.parse(rejected.body.data)).toMatchObject({ status: "rejected", rejectReason: "duplicate" });
    expect((await decide("reject", ids.alsoInA, editorA, { reason: "duplicate" })).status).toBe(200);
    expect((await decide("reject", ids.alsoInA, editorA, { reason: "nonsense" })).status).toBe(422);
    const mine = await call("/v1/me/submissions", { headers: submitter.bearer });
    const history = SubmissionSchema.array().parse((mine.body.data as { submissions: unknown }).submissions);
    expect(history.find((item) => item.id === ids.alsoInA)).toMatchObject({ status: "rejected", rejectReason: "duplicate" });
  });

  test("undoing an approval removes the spot; approving again brings back the same spot", async () => {
    const spotId = spotIds[0]!;
    const undone = await post(`/v1/review/${ids.inA}/undo`, editorA);
    expect(SubmissionSchema.parse(undone.body.data)).toMatchObject({ status: "pending", spotId });
    expect((await db.select({ status: spot.status }).from(spot).where(eq(spot.id, spotId)))[0]?.status).toBe("removed");
    expect((await post(`/v1/review/${ids.inA}/undo`, editorA)).status).toBe(200);
    expect((await post(`/v1/review/${ids.inA}/undo`, admin)).status).toBe(409);

    const again = SubmissionSchema.parse((await decide("approve", ids.inA, editorA)).body.data);
    expect(again.spotId).toBe(spotId);
    expect((await db.select({ status: spot.status }).from(spot).where(eq(spot.id, spotId)))[0]?.status).toBe("published");
  });

  test("only the reviewer undoes, within ten minutes; admins always can", async () => {
    await db
      .update(submission)
      .set({ reviewedAt: sql`now() - interval '11 minutes'` })
      .where(and(eq(submission.id, ids.alsoInA), eq(submission.status, "rejected")));
    expect((await post(`/v1/review/${ids.alsoInA}/undo`, editorA)).status).toBe(403);
    expect((await post(`/v1/review/${ids.inA}/undo`, editorB)).status).toBe(403);
    const byAdmin = await post(`/v1/review/${ids.alsoInA}/undo`, admin);
    expect(SubmissionSchema.parse(byAdmin.body.data)).toMatchObject({ status: "pending", rejectReason: null });
    const actions = await db.select({ action: reviewEvent.action }).from(reviewEvent).where(eq(reviewEvent.submissionId, ids.alsoInA)).orderBy(reviewEvent.id);
    expect(actions.map((row) => row.action)).toEqual(["reject", "undo"]);
  });

  test("an admin's new spot is published at once, and a resend returns it unchanged", async () => {
    const body = JSON.stringify({
      kind: "new_spot",
      title: "Admin ledge",
      spotKind: "street",
      latitude: 51.5061,
      longitude: -0.1161,
      photos: [{ photoId: photoIds[2], thumbhash, credit: { takenBy: "submitter" } }],
    });
    const send = () => call(`/v1/submissions/${ids.byAdmin}`, { method: "PUT", headers: { ...admin.bearer, "content-type": "application/json" }, body });
    const published = SubmissionSchema.parse((await send()).body.data);
    expect(published.status).toBe("approved");
    spotIds.push(published.spotId!);
    expect((await db.select({ status: spot.status }).from(spot).where(eq(spot.id, published.spotId!)))[0]?.status).toBe("published");
    expect(ours(ReviewQueueSchema.parse((await queue(admin)).body.data).items)).not.toContain(ids.byAdmin);
    expect(SubmissionSchema.parse((await send()).body.data)).toMatchObject({ status: "approved", spotId: published.spotId });
  });
});
