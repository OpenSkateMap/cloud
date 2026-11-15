import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Database, openDatabase, schema } from "@openskatemap/db";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { ReviewQueueSchema, SubmissionSchema } from "../src/lib/submission-schemas.ts";
import { call, createRider, e2eUrl } from "./support.ts";

const { city, cityEditor, photoUpload, spot, spotPhoto, submission, user } = schema;

const segment = (marker: number, payload: number[]) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
const jpeg = new Uint8Array([0xff, 0xd8, ...segment(0xc0, [8, 0x01, 0xe0, 0x02, 0x80, 1, 1, 0x11, 0]), 0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, 0x12, 0xff, 0xd9]);
const thumbhash = "1QcSHQRnh493V4dIh4eXh1h4kJUI";

type Rider = Awaited<ReturnType<typeof createRider>>;

describe.skipIf(!e2eUrl)("spot edits with photos (database)", () => {
  const database = e2eUrl ? openDatabase(e2eUrl) : undefined;
  const tag = crypto.randomUUID().slice(0, 8);
  const home = { id: `e2e-city-${tag}-photos`, slug: `e2e-${tag}-photos` };
  const made = { spots: [] as string[], uploads: [] as string[], submissions: [] as string[] };
  let db: Database;
  let adder: Rider, suggester: Rider, editor: Rider, admin: Rider;

  const json = (method: string, as: Rider, body: unknown) => ({
    method,
    headers: { ...as.bearer, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const submissionId = () => {
    const id = crypto.randomUUID();
    made.submissions.push(id);
    return id;
  };
  const addPhoto = (spotId: string, id: string, position: number, uploadedBy = adder.userId) =>
    db.insert(spotPhoto).values({ id, spotId, r2Key: `photos/e2e-${tag}-${id}.jpg`, width: 640, height: 480, thumbhash, credit: position === 1 ? "Dima" : null, hasPermission: true, uploadedBy, position });
  const stairs = async () => {
    const spotId = `e2e-spot-${tag}-${crypto.randomUUID().slice(0, 8)}`;
    made.spots.push(spotId);
    await db.insert(spot).values({ id: spotId, title: "Hubba Stairs", kind: "street", location: { latitude: 51.5066, longitude: -0.1169 }, createdBy: adder.userId });
    const [a, b, c] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()] as const;
    const all = [a, b, c];
    for (const [position, id] of all.entries()) await addPhoto(spotId, id, position);
    return { spotId, a, b, c, all };
  };
  const uploadPhoto = async () => {
    const id = crypto.randomUUID();
    made.uploads.push(id);
    await call(`/v1/photos/${id}`, { method: "PUT", headers: { ...suggester.bearer, "content-type": "image/jpeg" }, body: jpeg });
    return id;
  };
  const upload = (id: string) => ({ photoId: id, thumbhash, credit: { takenBy: "submitter" } });
  const suggest = (id: string, spotId: string, body: Record<string, unknown>, as: Rider = suggester) =>
    call(`/v1/spot-edits/${id}`, json("PUT", as, { spotId, changes: {}, ...body }));
  const seen = async (id: string) =>
    (await db.select({ updatedAt: submission.updatedAt }).from(submission).where(eq(submission.id, id)))[0]!.updatedAt.toISOString();
  const decide = async (id: string, body: Record<string, unknown> = {}) =>
    call(`/v1/review/${id}/approve`, json("POST", editor, { seenUpdatedAt: await seen(id), ...body }));
  const approve = (id: string, body: Record<string, unknown> = {}) => decide(id, { wholePhotoList: true, ...body });
  const undo = (id: string) => call(`/v1/review/${id}/undo`, json("POST", editor, {}));
  const photos = (spotId: string) =>
    db.select({ id: spotPhoto.id, position: spotPhoto.position, uploadedBy: spotPhoto.uploadedBy }).from(spotPhoto).where(eq(spotPhoto.spotId, spotId)).orderBy(asc(spotPhoto.position));
  const photoIds = async (spotId: string) => (await photos(spotId)).map((photo) => photo.id);
  const version = async (spotId: string) => (await db.select({ version: spot.version }).from(spot).where(eq(spot.id, spotId)))[0]!.version;
  const fromHistory = async (id: string) => {
    const history = await call("/v1/me/submissions", { headers: suggester.bearer });
    return (history.body.data as { submissions: unknown[] }).submissions.map((row) => SubmissionSchema.parse(row)).find((row) => row.id === id)!;
  };

  beforeAll(async () => {
    db = (await database!).db;
    [adder, suggester, editor, admin] = [await createRider(db, "Adder"), await createRider(db, "Suggester"), await createRider(db, "Editor"), await createRider(db, "Admin")];
    await db.insert(city).values({ ...home, name: `E2E Photos ${tag}`, countryCode: "GB", area: sql`ST_Multi(ST_MakeEnvelope(-0.125, 51.50, -0.105, 51.51, 4326))` });
    await db.update(user).set({ role: "editor" }).where(eq(user.id, editor.userId));
    await db.update(user).set({ role: "admin" }).where(eq(user.id, admin.userId));
    await db.insert(cityEditor).values({ cityId: home.id, userId: editor.userId });
  });

  afterAll(async () => {
    await db.delete(submission).where(inArray(submission.id, made.submissions));
    await db.delete(spot).where(inArray(spot.id, made.spots));
    await db.delete(photoUpload).where(inArray(photoUpload.id, made.uploads));
    await db.delete(city).where(eq(city.id, home.id));
    await db.delete(user).where(inArray(user.id, [adder, suggester, editor, admin].map((rider) => rider.userId)));
    await (await database!).close();
  });

  test("an edit's photo order names only its base and its own new photos, places every new one, and changes something", async () => {
    const { spotId, a, all } = await stairs();
    const id = submissionId();
    const stranger = await suggest(id, spotId, { photoEdit: { base: all, order: [a, crypto.randomUUID()] } });
    expect([stranger.status, stranger.body.error?.code]).toEqual([422, "validation_failed"]);
    const unplaced = await suggest(id, spotId, { photos: [upload(await uploadPhoto())], photoEdit: { base: all, order: [a] } });
    expect(unplaced.status).toBe(422);
    const same = await suggest(id, spotId, { photoEdit: { base: all, order: all } });
    expect(same.status).toBe(422);
  });

  test("an order naming one of the spot's photos outside its base is refused, so approval can't place it twice", async () => {
    const { spotId, a, b, c } = await stairs();
    const outside = await suggest(submissionId(), spotId, { photoEdit: { base: [a, b], order: [c, a, b] } });
    expect([outside.status, outside.body.error?.code]).toEqual([422, "validation_failed"]);
    const unseen = await suggest(submissionId(), spotId, { photoEdit: { base: [], order: [a] } });
    expect(unseen.status).toBe(422);
  });

  test("an edit reorders, removes and adds; the card lists its photos with the spot's own marked", async () => {
    const { spotId, a, c, all } = await stairs();
    const added = await uploadPhoto();
    const id = submissionId();
    const saved = await suggest(id, spotId, { photos: [upload(added)], photoEdit: { base: all, order: [added, c, a] } });
    expect(saved.status).toBe(200);
    const edit = SubmissionSchema.parse(saved.body.data);
    expect(edit.changedFields).toEqual(["photos"]);
    expect(edit.photos.map((photo) => [photo.photoId, photo.existing])).toEqual([[added, false], [c, true], [a, true]]);

    const queue = ReviewQueueSchema.parse((await call("/v1/review/queue?limit=50", { headers: editor.bearer })).body.data);
    const card = queue.items.find((item) => item.id === id)!;
    expect(card.photos.map((photo) => photo.photoId)).toEqual([added, c, a]);
    expect([card.current?.photoCount, card.current?.removedPhotoCount]).toEqual([3, 1]);
  });

  test("approval makes the edit's list the spot's, keeping a photo the spot gained after the edit was sent", async () => {
    const { spotId, a, c, all } = await stairs();
    const added = await uploadPhoto();
    const id = submissionId();
    expect((await suggest(id, spotId, { photos: [upload(added)], photoEdit: { base: all, order: [added, c, a] } })).status).toBe(200);
    const late = crypto.randomUUID();
    await addPhoto(spotId, late, 3);
    const before = await version(spotId);

    expect((await approve(id)).status).toBe(200);
    const after = await photos(spotId);
    expect(after.map((photo) => photo.id).slice(1)).toEqual([c, a, late]);
    expect(after.map((photo) => photo.position)).toEqual([0, 1, 2, 3]);
    expect(after[0]?.uploadedBy).toBe(suggester.userId);
    expect(await version(spotId)).toBeGreaterThan(before);
  });

  test("undo brings a removed photo back under its id and credit, in the old order, while nothing changed since", async () => {
    const { spotId, a, b, c, all } = await stairs();
    const id = submissionId();
    expect((await suggest(id, spotId, { photoEdit: { base: all, order: [c, a] } })).status).toBe(200);
    expect((await approve(id)).status).toBe(200);

    const undone = await undo(id);
    expect(SubmissionSchema.parse(undone.body.data).status).toBe("pending");
    expect(await photoIds(spotId)).toEqual([a, b, c]);
    const [credited] = await db.select({ credit: spotPhoto.credit }).from(spotPhoto).where(eq(spotPhoto.id, b));
    expect(credited?.credit).toBe("Dima");
  });

  test("a photo an edit kept that another approval removed stays gone; the undo of that approval brings it back to the edit", async () => {
    const { spotId, a, b, c, all } = await stairs();
    const [removesB, keepsB] = [submissionId(), submissionId()];
    expect((await suggest(removesB, spotId, { photoEdit: { base: all, order: [c, a] } })).status).toBe(200);
    expect((await suggest(keepsB, spotId, { photoEdit: { base: all, order: [b, c] } })).status).toBe(200);

    expect((await approve(removesB)).status).toBe(200);
    expect((await fromHistory(keepsB)).photos.map((photo) => photo.photoId)).toEqual([c]);
    expect((await undo(removesB)).status).toBe(200);
    expect((await fromHistory(keepsB)).photos.map((photo) => photo.photoId)).toEqual([b, c]);

    expect((await approve(keepsB)).status).toBe(200);
    expect(await photoIds(spotId)).toEqual([b, c]);
    expect((await undo(keepsB)).status).toBe(200);
    expect(await photoIds(spotId)).toEqual([a, b, c]);
  });

  test("a photo gone when an edit was saved isn't the edit's to remove when an undo brings it back", async () => {
    const { spotId, a, b, c, all } = await stairs();
    const [removesB, reorders] = [submissionId(), submissionId()];
    expect((await suggest(removesB, spotId, { photoEdit: { base: all, order: [a, c] } })).status).toBe(200);
    expect((await approve(removesB)).status).toBe(200);
    expect((await suggest(reorders, spotId, { photoEdit: { base: all, order: [c, b, a] } })).status).toBe(200);
    expect((await undo(removesB)).status).toBe(200);

    expect((await approve(reorders)).status).toBe(200);
    expect(await photoIds(spotId)).toEqual([c, a, b]);
  });

  test("an edit without photoEdit (1.0.1) holds only the photos it adds, and they go after the spot's own", async () => {
    const { spotId, all } = await stairs();
    const id = submissionId();
    const saved = SubmissionSchema.parse((await suggest(id, spotId, { photos: [upload(await uploadPhoto())] })).body.data);
    expect(saved.photos.map((photo) => photo.existing)).toEqual([false]);
    expect((await decide(id)).status).toBe(200);
    const after = await photos(spotId);
    expect(after.map((photo) => photo.id).slice(0, 3)).toEqual(all);
    expect(after[3]?.uploadedBy).toBe(suggester.userId);
    expect((await undo(id)).status).toBe(200);
    expect(await photoIds(spotId)).toEqual(all);
  });

  test("a 1.0.1 edit approved without its photos applies its other changes and leaves the spot's photos", async () => {
    const { spotId, all } = await stairs();
    const id = submissionId();
    expect((await suggest(id, spotId, { changes: { title: "Hubba Hideout" }, photos: [upload(await uploadPhoto())] })).status).toBe(200);
    expect((await decide(id, { edits: { photoIds: [] } })).status).toBe(200);
    const [row] = await db.select({ title: spot.title }).from(spot).where(eq(spot.id, spotId));
    expect(row?.title).toBe("Hubba Hideout");
    expect(await photoIds(spotId)).toEqual(all);
  });

  test("a photo the spot gained after the editor opened stays; one it showed that's gone since is skipped", async () => {
    const { spotId, a, b, c, all } = await stairs();
    const extra = crypto.randomUUID();
    await addPhoto(spotId, extra, 3);
    const ghost = crypto.randomUUID();
    const id = submissionId();
    const saved = await suggest(id, spotId, { photoEdit: { base: [...all, ghost], order: [b, ghost, a, c] } });
    expect(SubmissionSchema.parse(saved.body.data).photos.map((photo) => photo.photoId)).toEqual([b, a, c]);

    expect((await approve(id)).status).toBe(200);
    expect(await photoIds(spotId)).toEqual([b, a, c, extra]);
    expect((await undo(id)).status).toBe(200);
    expect(await photoIds(spotId)).toEqual([a, b, c, extra]);
  });

  test("undo brings back a removed photo whose uploader has deleted their account, unattributed", async () => {
    const { spotId, a, b, c, all } = await stairs();
    const gone = await createRider(db, "Gone");
    const orphan = crypto.randomUUID();
    await addPhoto(spotId, orphan, 3, gone.userId);
    const id = submissionId();
    expect((await suggest(id, spotId, { photoEdit: { base: [...all, orphan], order: all } })).status).toBe(200);
    expect((await approve(id)).status).toBe(200);
    expect(await photoIds(spotId)).toEqual(all);

    await db.delete(user).where(eq(user.id, gone.userId));
    expect((await undo(id)).status).toBe(200);
    expect((await photos(spotId)).map((photo) => [photo.id, photo.uploadedBy])).toEqual([
      [a, adder.userId],
      [b, adder.userId],
      [c, adder.userId],
      [orphan, null],
    ]);
  });

  test("an edit that only adds photos keeps the spot's order as it is when approved, so a cover chosen since stays", async () => {
    const { spotId, a, b, c, all } = await stairs();
    const added = await uploadPhoto();
    const id = submissionId();
    expect((await suggest(id, spotId, { photos: [upload(added)], photoEdit: { base: all, order: [...all, added] } })).status).toBe(200);
    for (const [index, photoId] of [c, a, b].entries()) {
      await db.update(spotPhoto).set({ position: -1 - index }).where(eq(spotPhoto.id, photoId));
    }
    for (const [index, photoId] of [c, a, b].entries()) {
      await db.update(spotPhoto).set({ position: index }).where(eq(spotPhoto.id, photoId));
    }

    expect((await approve(id)).status).toBe(200);
    const after = await photos(spotId);
    expect(after.map((photo) => photo.id).slice(0, 3)).toEqual([c, a, b]);
    expect(after[3]?.uploadedBy).toBe(suggester.userId);
  });

  test("approving a whole-list photo change needs wholePhotoList; an edit that leaves the photos doesn't", async () => {
    const { spotId, a, b, c, all } = await stairs();
    const id = submissionId();
    expect((await suggest(id, spotId, { photoEdit: { base: all, order: [c, a] } })).status).toBe(200);
    const before = await version(spotId);

    const unaware = await decide(id);
    expect([unaware.status, unaware.body.error?.code]).toEqual([422, "validation_failed"]);
    expect((await fromHistory(id)).status).toBe("pending");
    expect(await photoIds(spotId)).toEqual([a, b, c]);
    expect(await version(spotId)).toBe(before);

    expect((await approve(id)).status).toBe(200);
    expect(await photoIds(spotId)).toEqual([c, a]);

    const textOnly = submissionId();
    const saved = await suggest(textOnly, spotId, { changes: { title: "Hubba Ledges" }, photoEdit: { base: [c, a], order: [c, a] } });
    expect(SubmissionSchema.parse(saved.body.data).changedFields).toEqual(["title"]);
    expect((await decide(textOnly)).status).toBe(200);
  });

  test("an admin's own photo edit applies at once", async () => {
    const { spotId, a, b, c, all } = await stairs();
    const saved = await suggest(submissionId(), spotId, { photoEdit: { base: all, order: [b, c, a] } }, admin);
    expect(saved.status).toBe(200);
    expect(SubmissionSchema.parse(saved.body.data).status).toBe("approved");
    expect(await photoIds(spotId)).toEqual([b, c, a]);
  });

  test("a new spot can have no photo, and its approval publishes it without one", async () => {
    const id = submissionId();
    const saved = await call(
      `/v1/submissions/${id}`,
      json("PUT", suggester, { kind: "new_spot", title: "Bare Ledge", spotKind: "street", latitude: 51.507, longitude: -0.118, photos: [] }),
    );
    expect(saved.status).toBe(200);
    expect(SubmissionSchema.parse(saved.body.data).photos).toEqual([]);
    const approved = await decide(id);
    expect(approved.status).toBe(200);
    const published = SubmissionSchema.parse(approved.body.data).spotId!;
    made.spots.push(published);
    expect(await db.$count(spotPhoto, eq(spotPhoto.spotId, published))).toBe(0);
    const card = await call(`/v1/spots/${published}/card`);
    expect(card.body.data).toMatchObject({ title: "Bare Ledge", cover: null });
  });
});
