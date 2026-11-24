import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type Database, openDatabase, schema } from "@openskatemap/db";
import { asc, eq, inArray } from "drizzle-orm";
import { cleanMp4 } from "../src/lib/mp4.ts";
import { ClipUploadSchema, SubmissionSchema } from "../src/lib/submission-schemas.ts";
import { call, createRider, e2eUrl, photosBucket } from "./support.ts";

const { clipUpload, photoUpload, spot, spotPhoto, submission, user } = schema;

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url).pathname));
const clip = fixture("clip-metadata.mp4");
const segment = (marker: number, payload: number[]) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
const jpeg = new Uint8Array([0xff, 0xd8, ...segment(0xc0, [8, 0x01, 0xe0, 0x02, 0x80, 1, 1, 0x11, 0]), 0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, 0x12, 0xff, 0xd9]);
const thumbhash = "1QcSHQRnh493V4dIh4eXh1h4kJUI";

type Rider = Awaited<ReturnType<typeof createRider>>;
type RawPhoto = { id: string; key: string; clip?: unknown };

describe.skipIf(!e2eUrl)("clips (database)", () => {
  const database = e2eUrl ? openDatabase(e2eUrl) : undefined;
  const made = { clips: [] as string[], photos: [] as string[], submissions: [] as string[], spots: [] as string[] };
  let db: Database;
  let rider: Rider, other: Rider, admin: Rider;

  const id = (list: string[]) => {
    const value = crypto.randomUUID();
    list.push(value);
    return value;
  };
  const putClip = (clipId: string, as: Rider, body: Uint8Array = clip, type = "video/mp4") =>
    call(`/v1/clips/${clipId}`, { method: "PUT", headers: { ...as.bearer, "content-type": type }, body });
  const uploadClip = async (as: Rider = rider) => {
    const clipId = id(made.clips);
    expect((await putClip(clipId, as)).status).toBe(200);
    return clipId;
  };
  const uploadPhoto = async (as: Rider = rider) => {
    const photoId = id(made.photos);
    expect((await call(`/v1/photos/${photoId}`, { method: "PUT", headers: { ...as.bearer, "content-type": "image/jpeg" }, body: jpeg })).status).toBe(200);
    return photoId;
  };
  const json = (method: string, as: Rider, body: unknown) => ({ method, headers: { ...as.bearer, "content-type": "application/json" }, body: JSON.stringify(body) });
  const photo = (photoId: string, clipId?: string) => ({ photoId, thumbhash, credit: { takenBy: "submitter" }, ...(clipId === undefined ? {} : { clipId }) });
  const newSpot = (photos: unknown[]) => ({ kind: "new_spot", title: "Clip Ledge", spotKind: "street", latitude: -80, longitude: 10, photos });
  const submit = (submissionId: string, as: Rider, photos: unknown[]) => call(`/v1/submissions/${submissionId}`, json("PUT", as, newSpot(photos)));
  const decide = async (submissionId: string, action: "approve" | "undo") => {
    const [row] = await db.select({ updatedAt: submission.updatedAt }).from(submission).where(eq(submission.id, submissionId));
    return call(`/v1/review/${submissionId}/${action}`, json("POST", admin, action === "approve" ? { seenUpdatedAt: row!.updatedAt.toISOString() } : {}));
  };
  const detailPhotos = async (spotId: string) => {
    const { body } = await call(`/v1/spots?ids=${spotId}`, { headers: rider.bearer });
    return (body.data as { spots: { photos: RawPhoto[] }[] }).spots[0]!.photos;
  };
  const spotPhotoIds = async (spotId: string) =>
    (await db.select({ id: spotPhoto.id }).from(spotPhoto).where(eq(spotPhoto.spotId, spotId)).orderBy(asc(spotPhoto.position))).map((row) => row.id);
  const storedKey = async (clipId: string) => (await db.select({ key: clipUpload.r2Key }).from(clipUpload).where(eq(clipUpload.id, clipId)))[0]!.key;

  beforeAll(async () => {
    db = (await database!).db;
    [rider, other, admin] = [await createRider(db, "Filmer"), await createRider(db, "Someone Else"), await createRider(db, "Admin")];
    await db.update(user).set({ role: "admin" }).where(eq(user.id, admin.userId));
  });

  afterAll(async () => {
    await db.delete(submission).where(inArray(submission.id, made.submissions));
    await db.delete(spot).where(inArray(spot.id, made.spots));
    await db.delete(clipUpload).where(inArray(clipUpload.id, made.clips));
    await db.delete(photoUpload).where(inArray(photoUpload.id, made.photos));
    await db.delete(user).where(inArray(user.id, [rider, other, admin].map((each) => each.userId)));
    await (await database!).close();
  });

  test("a clip is stored without its metadata under a random key, sized and timed by the server", async () => {
    const clipId = id(made.clips);
    const { status, body } = await putClip(clipId, rider);
    expect(status).toBe(200);
    const clean = cleanMp4(clip)._unsafeUnwrap().bytes;
    expect(ClipUploadSchema.parse(body.data)).toEqual({ id: clipId, width: 96, height: 64, durationMs: 2000, bytes: clean.length });
    const key = await storedKey(clipId);
    expect(key).toMatch(/^clips\/[\da-f-]{36}\.mp4$/);
    expect(photosBucket.objects.get(key)).toEqual({ bytes: clean, contentType: "video/mp4" });
  });

  test("the same id again returns the stored clip; nobody else can take the id", async () => {
    const clipId = await uploadClip();
    const before = photosBucket.objects.size;
    const again = await putClip(clipId, rider, fixture("clip-17s.mp4"));
    expect([again.status, ClipUploadSchema.parse(again.body.data).durationMs]).toEqual([200, 2000]);
    expect(photosBucket.objects.size).toBe(before);
    const stolen = await putClip(clipId, other);
    expect([stolen.status, stolen.body.error?.code]).toEqual([403, "forbidden"]);
  });

  test("what isn't one short, silent, faststart H.264 MP4 is refused and stores nothing", async () => {
    const clipId = crypto.randomUUID();
    const answers = await Promise.all([
      putClip(clipId, rider, clip, "video/quicktime"),
      putClip(clipId, rider, fixture("clip-audio.mp4")),
      putClip(clipId, rider, fixture("clip-17s.mp4")),
      putClip(clipId, rider, fixture("clip-moov-last.mp4")),
      putClip(clipId, rider, new Uint8Array(15 * 1024 * 1024 + 1)),
    ]);
    expect(answers.map(({ status, body }) => [status, body.error?.code])).toEqual(Array(5).fill([422, "validation_failed"]));
    expect(await db.select().from(clipUpload).where(eq(clipUpload.id, clipId))).toEqual([]);
  });

  test("a draft waits for its clips, and names the missing ones (someone else's too)", async () => {
    const [mine, theirs, unknown] = [await uploadPhoto(), await uploadClip(other), crypto.randomUUID()];
    const { status, body } = await submit(id(made.submissions), rider, [photo(mine, theirs), photo(await uploadPhoto(), unknown)]);
    expect([status, body.error?.code]).toEqual([422, "validation_failed"]);
    expect(body.error).toMatchObject({ details: { missingClips: [theirs, unknown] } });
    const twice = await uploadClip();
    expect((await submit(id(made.submissions), rider, [photo(mine, twice), photo(await uploadPhoto(), twice)])).status).toBe(422);
  });

  test("a new spot's photo plays its clip once approved, through an undo and a new approval; photos without one leave it out", async () => {
    const [withClip, plain, clipId] = [await uploadPhoto(), await uploadPhoto(), await uploadClip()];
    const submissionId = id(made.submissions);
    const saved = SubmissionSchema.parse((await submit(submissionId, rider, [photo(withClip, clipId), photo(plain)])).body.data);
    const expected = { key: await storedKey(clipId), width: 96, height: 64, durationMs: 2000 };
    expect(saved.photos.map((each) => each.clip)).toEqual([expected, undefined]);

    const approved = SubmissionSchema.parse((await decide(submissionId, "approve")).body.data);
    const spotId = approved.spotId!;
    made.spots.push(spotId);
    const photos = await detailPhotos(spotId);
    expect(photos[0]?.clip).toEqual(expected);
    expect("clip" in photos[1]!).toBe(false);

    expect((await decide(submissionId, "undo")).status).toBe(200);
    expect((await decide(submissionId, "approve")).status).toBe(200);
    expect((await detailPhotos(spotId)).map((each) => each.clip)).toEqual([expected, undefined]);

    const { version } = (await db.select({ version: spot.version }).from(spot).where(eq(spot.id, spotId)))[0]!;
    const card = await call(`/v1/spots/${spotId}/card`, {});
    const sync = await call(`/v1/sync/spots?cursor=${version - 1}&limit=1`, { headers: rider.bearer });
    expect((sync.body.data as { items: { id: string }[] }).items[0]?.id).toBe(spotId);
    expect([JSON.stringify(card.body).includes("clips/"), JSON.stringify(sync.body).includes("clips/")]).toEqual([false, false]);
  });

  test("an admin's edit adds a photo with a clip, another removes it, and undoing each puts back what was there", async () => {
    const spotId = id(made.spots);
    await db.insert(spot).values({ id: spotId, title: "Clip Gap", kind: "street", location: { latitude: -80, longitude: 11 }, createdBy: rider.userId });
    const [photoId, clipId] = [await uploadPhoto(admin), await uploadClip(admin)];
    const adds = id(made.submissions);
    const added = await call(`/v1/spot-edits/${adds}`, json("PUT", admin, { spotId, changes: {}, photos: [photo(photoId, clipId)], photoEdit: { base: [], order: [photoId] } }));
    expect(SubmissionSchema.parse(added.body.data).status).toBe("approved");
    const expected = { key: await storedKey(clipId), width: 96, height: 64, durationMs: 2000 };
    expect((await detailPhotos(spotId)).map((each) => each.clip)).toEqual([expected]);

    const [clipped, replacement] = [await spotPhotoIds(spotId), await uploadPhoto(admin)];
    const removes = id(made.submissions);
    const removed = await call(`/v1/spot-edits/${removes}`, json("PUT", admin, { spotId, changes: {}, photos: [photo(replacement)], photoEdit: { base: clipped, order: [replacement] } }));
    expect(SubmissionSchema.parse(removed.body.data).status).toBe("approved");
    expect((await detailPhotos(spotId)).map((each) => each.clip)).toEqual([undefined]);
    expect((await decide(removes, "undo")).status).toBe(200);
    expect(await spotPhotoIds(spotId)).toEqual(clipped);
    expect((await detailPhotos(spotId)).map((each) => each.clip)).toEqual([expected]);

    expect((await decide(adds, "undo")).status).toBe(200);
    expect(await detailPhotos(spotId)).toEqual([]);
  });
});
