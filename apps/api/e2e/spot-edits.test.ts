import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Database, openDatabase, schema } from "@openskatemap/db";
import { eq, inArray, sql } from "drizzle-orm";
import { ReviewQueueSchema, SubmissionSchema } from "../src/lib/submission-schemas.ts";
import { call, createRider, e2eUrl } from "./support.ts";

const { city, cityEditor, photoUpload, spot, spotPhoto, submission, user } = schema;

const segment = (marker: number, payload: number[]) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
const jpeg = new Uint8Array([0xff, 0xd8, ...segment(0xc0, [8, 0x01, 0xe0, 0x02, 0x80, 1, 1, 0x11, 0]), 0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, 0x12, 0xff, 0xd9]);
const thumbhash = "1QcSHQRnh493V4dIh4eXh1h4kJUI";

type Rider = Awaited<ReturnType<typeof createRider>>;

describe.skipIf(!e2eUrl)("spot edits (database)", () => {
  const database = e2eUrl ? openDatabase(e2eUrl) : undefined;
  const tag = crypto.randomUUID().slice(0, 8);
  const home = { id: `e2e-city-${tag}-edits`, slug: `e2e-${tag}-edits` };
  const away = { id: `e2e-city-${tag}-away`, slug: `e2e-${tag}-away` };
  const spots = { ledges: `e2e-spot-${tag}-ledges`, hidden: `e2e-spot-${tag}-hidden` };
  const ids = { first: crypto.randomUUID(), second: crypto.randomUUID(), noop: crypto.randomUUID(), own: crypto.randomUUID(), moved: crypto.randomUUID(), fresh: crypto.randomUUID(), admin: crypto.randomUUID() };
  const addedPhoto = crypto.randomUUID();
  let db: Database;
  let adder: Rider, suggester: Rider, editor: Rider, outsider: Rider, admin: Rider;

  const json = (method: string, as: Rider, body: unknown) => ({
    method,
    headers: { ...as.bearer, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const suggest = (id: string, as: Rider, body: Record<string, unknown>) => call(`/v1/spot-edits/${id}`, json("PUT", as, { spotId: spots.ledges, ...body }));
  const seen = async (id: string) =>
    (await db.select({ updatedAt: submission.updatedAt }).from(submission).where(eq(submission.id, id)))[0]!.updatedAt.toISOString();
  const decide = async (action: "approve" | "reject", id: string, as: Rider, body: Record<string, unknown> = {}) =>
    call(`/v1/review/${id}/${action}`, json("POST", as, { seenUpdatedAt: await seen(id), ...body }));
  const ledges = async () => (await db.select().from(spot).where(eq(spot.id, spots.ledges)))[0]!;

  beforeAll(async () => {
    db = (await database!).db;
    [adder, suggester, editor, outsider, admin] = [
      await createRider(db, "Adder"),
      await createRider(db, "Suggester"),
      await createRider(db, "Editor"),
      await createRider(db, "Outsider"),
      await createRider(db, "Admin"),
    ];
    await db.update(user).set({ role: "admin" }).where(eq(user.id, admin.userId));
    await db.insert(city).values([
      { ...home, name: `E2E Edits ${tag}`, countryCode: "GB", area: sql`ST_Multi(ST_MakeEnvelope(-0.125, 51.50, -0.105, 51.51, 4326))` },
      { ...away, name: `E2E Away ${tag}`, countryCode: "ES", area: sql`ST_Multi(ST_MakeEnvelope(2.13, 41.37, 2.15, 41.39, 4326))` },
    ]);
    for (const [rider, cityId] of [[editor, home.id], [outsider, away.id]] as const) {
      await db.update(user).set({ role: "editor" }).where(eq(user.id, rider.userId));
      await db.insert(cityEditor).values({ cityId, userId: rider.userId });
    }
    await db.insert(spot).values([
      {
        id: spots.ledges,
        title: "Well Ledges",
        description: "Marble ledges",
        kind: "plaza",
        obstacles: ["ledges", "banks"],
        condition: "skateable",
        location: { latitude: 51.5066, longitude: -0.1169 },
        createdBy: adder.userId,
      },
      {
        id: spots.hidden,
        title: "Backyard Bowl",
        kind: "diy",
        visibility: "private",
        location: { latitude: 51.505, longitude: -0.115 },
        createdBy: adder.userId,
      },
    ]);
    await db.insert(spotPhoto).values({
      id: `e2e-photo-${tag}`,
      spotId: spots.ledges,
      r2Key: `photos/e2e-${tag}.jpg`,
      width: 640,
      height: 480,
      thumbhash,
      hasPermission: true,
      uploadedBy: adder.userId,
      position: 0,
    });
    await call(`/v1/photos/${addedPhoto}`, { method: "PUT", headers: { ...suggester.bearer, "content-type": "image/jpeg" }, body: jpeg });
  });

  afterAll(async () => {
    await db.delete(submission).where(inArray(submission.id, Object.values(ids)));
    await db.delete(spot).where(inArray(spot.id, Object.values(spots)));
    await db.delete(photoUpload).where(eq(photoUpload.id, addedPhoto));
    await db.delete(city).where(inArray(city.id, [home.id, away.id]));
    await db.delete(user).where(inArray(user.id, [adder, suggester, editor, outsider, admin].map((rider) => rider.userId)));
    await (await database!).close();
  });

  test("a suggestion keeps only what differs, and one that changes nothing is refused", async () => {
    const saved = await suggest(ids.first, suggester, {
      changes: { title: "Well Ledges", obstacles: ["banks", "ledges"], condition: "knobbed" },
      note: "Knobbed since spring",
    });
    expect(saved.status).toBe(200);
    expect(SubmissionSchema.parse(saved.body.data)).toMatchObject({
      kind: "edit_spot",
      status: "pending",
      spotId: spots.ledges,
      changedFields: ["condition"],
      title: "Well Ledges",
      condition: "knobbed",
      obstacles: ["ledges", "banks"],
    });

    const nothing = await suggest(ids.noop, suggester, { changes: { title: "Well Ledges", condition: "skateable" } });
    expect([nothing.status, nothing.body.error?.code]).toEqual([422, "validation_failed"]);
    const empty = await suggest(ids.noop, suggester, { changes: {} });
    expect(empty.status).toBe(422);

    const hidden = await call(`/v1/spot-edits/${ids.noop}`, json("PUT", suggester, { spotId: spots.hidden, changes: { title: "Bowl" } }));
    expect([hidden.status, hidden.body.error?.code]).toEqual([404, "not_found"]);
    const unknown = await call(`/v1/spot-edits/${ids.noop}`, json("PUT", suggester, { spotId: `e2e-nope-${tag}`, changes: { title: "Bowl" } }));
    expect(unknown.status).toBe(404);
  });

  test("a resend replaces the pending suggestion; someone else's id is refused", async () => {
    const resent = await suggest(ids.first, suggester, {
      changes: { title: "Southbank Ledges", condition: "knobbed" },
      photos: [{ photoId: addedPhoto, thumbhash, credit: { takenBy: "submitter" } }],
    });
    expect(SubmissionSchema.parse(resent.body.data).changedFields.sort()).toEqual(["condition", "photos", "title"]);
    const [rows] = await db.select({ count: sql<number>`count(*)`.mapWith(Number) }).from(submission).where(eq(submission.id, ids.first));
    expect(rows?.count).toBe(1);

    const stolen = await suggest(ids.first, adder, { changes: { title: "Mine" } });
    expect([stolen.status, stolen.body.error?.code]).toEqual([403, "forbidden"]);

    const missing = await suggest(ids.second, suggester, {
      changes: { description: "Wet in winter" },
      photos: [{ photoId: crypto.randomUUID(), thumbhash, credit: { takenBy: "submitter" } }],
    });
    expect(missing.status).toBe(422);
  });

  test("a new spot can't reuse a suggested edit's id", async () => {
    const reused = await call(
      `/v1/submissions/${ids.first}`,
      json("PUT", suggester, {
        kind: "new_spot",
        title: "Not an edit",
        spotKind: "plaza",
        latitude: 51.5066,
        longitude: -0.1169,
        photos: [{ photoId: addedPhoto, thumbhash, credit: { takenBy: "submitter" } }],
      }),
    );
    expect([reused.status, reused.body.error?.code]).toEqual([409, "conflict"]);
    const [row] = await db.select({ kind: submission.kind, title: submission.title }).from(submission).where(eq(submission.id, ids.first));
    expect(row?.kind).toBe("edit_spot");
    expect(row?.title).not.toBe("Not an edit");
  });

  test("the review card shows the edit beside the spot as it is now", async () => {
    const queue = ReviewQueueSchema.parse((await call("/v1/review/queue?limit=50", { headers: editor.bearer })).body.data);
    const card = queue.items.find((item) => item.id === ids.first)!;
    expect(card).toMatchObject({ kind: "edit_spot", nearby: [], submitter: { id: suggester.userId, name: "Suggester" } });
    expect(card.current).toEqual({
      title: "Well Ledges",
      description: "Marble ledges",
      spotKind: "plaza",
      obstacles: ["ledges", "banks"],
      condition: "skateable",
      latitude: 51.5066,
      longitude: -0.1169,
      photoCount: 1,
      removedPhotoCount: 0,
    });
    const elsewhere = ReviewQueueSchema.parse((await call("/v1/review/queue?limit=50", { headers: outsider.bearer })).body.data);
    expect(elsewhere.items.some((item) => item.id === ids.first)).toBe(false);
  });

  test("approval applies only the changed fields, with the curator's adjustment, and moves the version", async () => {
    await db.update(spot).set({ description: "Marble ledges, dry under the bridge" }).where(eq(spot.id, spots.ledges));
    const before = await ledges();

    expect((await decide("approve", ids.first, outsider)).status).toBe(403);
    const approved = await decide("approve", ids.first, editor, { edits: { title: "Southbank Marble Ledges" } });
    expect(approved.status).toBe(200);
    expect(SubmissionSchema.parse(approved.body.data)).toMatchObject({ status: "approved", spotId: spots.ledges });

    const after = await ledges();
    expect(after).toMatchObject({
      title: "Southbank Marble Ledges",
      condition: "knobbed",
      description: "Marble ledges, dry under the bridge",
      kind: "plaza",
      createdBy: adder.userId,
    });
    expect(after.version).toBeGreaterThan(before.version);
    const photos = await db.select().from(spotPhoto).where(eq(spotPhoto.spotId, spots.ledges)).orderBy(spotPhoto.position);
    expect(photos.map((photo) => [photo.position, photo.uploadedBy])).toEqual([[0, adder.userId], [1, suggester.userId]]);

    const history = await call("/v1/me/submissions", { headers: suggester.bearer });
    const mine = (history.body.data as { submissions: unknown[] }).submissions.map((row) => SubmissionSchema.parse(row));
    expect(mine.find((row) => row.id === ids.first)).toMatchObject({ kind: "edit_spot", status: "approved", spotId: spots.ledges });

    expect((await decide("approve", ids.first, editor)).status).toBe(200);
  });

  test("undo puts back what the edit replaced, except what changed since", async () => {
    await db.update(spot).set({ condition: "busty" }).where(eq(spot.id, spots.ledges));
    const before = await ledges();
    const undone = await call(`/v1/review/${ids.first}/undo`, json("POST", editor, {}));
    expect(undone.status).toBe(200);
    expect(SubmissionSchema.parse(undone.body.data).status).toBe("pending");

    const after = await ledges();
    expect(after).toMatchObject({ status: "published", title: "Well Ledges", condition: "busty", description: "Marble ledges, dry under the bridge" });
    expect(after.version).toBeGreaterThan(before.version);
    const photos = await db.select({ uploadedBy: spotPhoto.uploadedBy }).from(spotPhoto).where(eq(spotPhoto.spotId, spots.ledges));
    expect(photos).toEqual([{ uploadedBy: adder.userId }]);
  });

  test("an approval that picks a photo from outside the edit changes nothing", async () => {
    const before = await ledges();
    const refused = await decide("approve", ids.first, editor, { edits: { title: "Never Saved", photoIds: [crypto.randomUUID()] } });
    expect([refused.status, refused.body.error?.code]).toEqual([422, "validation_failed"]);
    const after = await ledges();
    expect([after.title, after.condition, after.version]).toEqual([before.title, before.condition, before.version]);
    const [row] = await db.select({ status: submission.status }).from(submission).where(eq(submission.id, ids.first));
    expect(row?.status).toBe("pending");
  });

  test("a rejected suggestion leaves the spot as it is", async () => {
    await suggest(ids.second, suggester, { changes: { description: "Closed for good", condition: "demolished" } });
    const before = await ledges();
    const rejected = await decide("reject", ids.second, editor, { reason: "wrong_location" });
    expect(SubmissionSchema.parse(rejected.body.data)).toMatchObject({ status: "rejected", rejectReason: "wrong_location" });
    const after = await ledges();
    expect([after.description, after.condition, after.version]).toEqual([before.description, before.condition, before.version]);
  });

  test("the spot's adder reviews what others suggest for it, as its owner; their own suggestions go to curators", async () => {
    const queue = async (as: Rider) => ReviewQueueSchema.parse((await call("/v1/review/queue?limit=50", { headers: as.bearer })).body.data);
    const owned = await queue(adder);
    expect(owned.cityIds).toEqual([]);
    expect(owned.items.map((item) => [item.id, item.reviewAs])).toEqual([[ids.first, "owner"]]);
    expect((await queue(editor)).items.find((item) => item.id === ids.first)?.reviewAs).toBe("curator");
    expect((await queue(suggester)).items).toEqual([]);

    expect((await suggest(ids.own, adder, { changes: { description: "Dry under the bridge" } })).status).toBe(200);
    expect((await queue(adder)).items.some((item) => item.id === ids.own)).toBe(false);
    expect((await queue(editor)).items.find((item) => item.id === ids.own)?.reviewAs).toBe("curator");
    expect((await decide("approve", ids.own, adder)).status).toBe(403);
  });

  test("the owner decides a suggestion and can take it back", async () => {
    const approved = await decide("approve", ids.first, adder);
    expect(SubmissionSchema.parse(approved.body.data)).toMatchObject({ status: "approved", spotId: spots.ledges });
    expect((await ledges()).title).toBe("Southbank Ledges");

    const undone = await call(`/v1/review/${ids.first}/undo`, json("POST", adder, {}));
    expect(SubmissionSchema.parse(undone.body.data).status).toBe("pending");
    expect((await ledges()).title).toBe("Well Ledges");
  });

  test("a curator decides an edit only in both cities: the spot's and the one it moves to", async () => {
    expect((await suggest(ids.moved, outsider, { changes: { title: "Plaza Ledges", latitude: 41.38, longitude: 2.14 } })).status).toBe(200);
    const queue = ReviewQueueSchema.parse((await call("/v1/review/queue?limit=50", { headers: outsider.bearer })).body.data);
    expect(queue.items.some((item) => item.id === ids.moved)).toBe(false);
    const approved = await decide("approve", ids.moved, outsider);
    expect([approved.status, approved.body.error?.code]).toEqual([403, "forbidden"]);
    expect((await decide("reject", ids.moved, editor, { reason: "wrong_location" })).status).toBe(403);
    const after = await ledges();
    expect([after.title, after.cityId]).toEqual(["Well Ledges", home.id]);
  });

  test("an edit a curator can't decide takes no place in their queue's limit", async () => {
    const fresh = await call(
      `/v1/submissions/${ids.fresh}`,
      json("PUT", suggester, {
        kind: "new_spot",
        title: "Plaza Stairs",
        spotKind: "plaza",
        latitude: 41.381,
        longitude: 2.141,
        photos: [{ photoId: addedPhoto, thumbhash, credit: { takenBy: "submitter" } }],
      }),
    );
    expect(fresh.status).toBe(200);
    const queue = ReviewQueueSchema.parse((await call("/v1/review/queue?limit=1", { headers: outsider.bearer })).body.data);
    expect(queue.items.map((item) => item.id)).toEqual([ids.fresh]);
  });

  test("an admin's edit applies at once, approved by its author, and can still be undone", async () => {
    const before = await ledges();
    const edited = await suggest(ids.admin, admin, { changes: { description: "Marble ledges, waxed" } });
    expect(edited.status).toBe(200);
    expect(SubmissionSchema.parse(edited.body.data)).toMatchObject({ status: "approved", spotId: spots.ledges });
    const after = await ledges();
    expect(after.description).toBe("Marble ledges, waxed");
    expect(after.version).toBeGreaterThan(before.version);

    expect((await suggest(ids.admin, admin, { changes: { description: "Marble ledges, waxed" } })).status).toBe(200);
    const undone = await call(`/v1/review/${ids.admin}/undo`, json("POST", admin, {}));
    expect(SubmissionSchema.parse(undone.body.data).status).toBe("pending");
    expect((await ledges()).description).toBe(before.description);
  });
});
