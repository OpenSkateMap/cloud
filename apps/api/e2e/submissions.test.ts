import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "@hono/zod-openapi";
import { type Database, openDatabase, schema } from "@openskatemap/db";
import { eq, inArray, sql } from "drizzle-orm";
import { PhotoUploadSchema, SubmissionSchema } from "../src/lib/submission-schemas.ts";
import { call, createRider, e2eUrl, photosBucket, read } from "./support.ts";

const { city, photoUpload, submission, user } = schema;

const segment = (marker: number, payload: number[]) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
const jfif = segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const exif = segment(0xe1, [0x45, 0x78, 0x69, 0x66, 0, 0, 0x47, 0x50, 0x53]);
const frame = segment(0xc0, [8, 0x01, 0xe0, 0x02, 0x80, 1, 1, 0x11, 0]);
const scan = [0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, 0x12, 0x34, 0xff, 0xd9];
const photoWithExif = new Uint8Array([0xff, 0xd8, ...jfif, ...exif, ...frame, ...scan]);
const photoClean = new Uint8Array([0xff, 0xd8, ...jfif, ...frame, ...scan]);

describe.skipIf(!e2eUrl)("submissions (database)", () => {
  const database = e2eUrl ? openDatabase(e2eUrl) : undefined;
  const tag = crypto.randomUUID().slice(0, 8);
  const cityId = `e2e-city-${tag}`;
  let db: Database;
  let rider: Awaited<ReturnType<typeof createRider>>;
  let other: Awaited<ReturnType<typeof createRider>>;
  const photoIds = [crypto.randomUUID(), crypto.randomUUID()];
  const submissionIds: string[] = [];

  const upload = (photoId: string, as: { authorization: string }, body: Uint8Array = photoWithExif, type = "image/jpeg") =>
    call(`/v1/photos/${photoId}`, { method: "PUT", headers: { ...as, "content-type": type }, body });
  const draft = (overrides: Record<string, unknown> = {}) => ({
    kind: "new_spot",
    title: "  Undercroft Ledges ",
    spotKind: "plaza",
    obstacles: [" Ledges", "BANKS "],
    latitude: 51.5066,
    longitude: -0.1169,
    note: "Busy on weekends",
    photos: [
      { photoId: photoIds[0], thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI", credit: { takenBy: "submitter" } },
      { photoId: photoIds[1], thumbhash: "2QcSHQRnh493V4dIh4eXh1h4kJUI", credit: { takenBy: "someone_else", credit: "@photographer", hasPermission: true, sourceUrl: "https://example.com/p/1" } },
    ],
    ...overrides,
  });
  const submit = (submissionId: string, as: { authorization: string }, body: unknown = draft()) => {
    submissionIds.push(submissionId);
    return call(`/v1/submissions/${submissionId}`, { method: "PUT", headers: { ...as, "content-type": "application/json" }, body: JSON.stringify(body) });
  };

  beforeAll(async () => {
    db = (await database!).db;
    rider = await createRider(db, "Submitter");
    other = await createRider(db, "Someone Else");
    await db.insert(city).values({ id: cityId, slug: `e2e-${tag}`, name: `E2E ${tag}`, countryCode: "GB", area: sql`ST_Multi(ST_MakeEnvelope(-0.125, 51.50, -0.105, 51.51, 4326))` });
  });

  afterAll(async () => {
    if (submissionIds.length > 0) await db.delete(submission).where(inArray(submission.id, submissionIds));
    await db.delete(photoUpload).where(inArray(photoUpload.id, photoIds));
    await db.delete(city).where(eq(city.id, cityId));
    await db.delete(user).where(inArray(user.id, [rider.userId, other.userId]));
    await (await database!).close();
  });

  test("a photo is stored without its metadata, sized by the server", async () => {
    const before = photosBucket.objects.size;
    const { status, body } = await upload(photoIds[0]!, rider.bearer);
    expect(status).toBe(200);
    expect(PhotoUploadSchema.parse(body.data)).toEqual({ id: photoIds[0]!, width: 640, height: 480, bytes: photoClean.length });
    expect(photosBucket.objects.size).toBe(before + 1);
    const [row] = await db.select().from(photoUpload).where(eq(photoUpload.id, photoIds[0]!));
    expect(photosBucket.objects.get(row!.r2Key)).toEqual({ bytes: photoClean, contentType: "image/jpeg" });
    expect(row!.r2Key).not.toContain(rider.userId);
  });

  test("uploading the same id again returns the first upload; nobody else can take the id", async () => {
    const before = photosBucket.objects.size;
    const again = await upload(photoIds[0]!, rider.bearer, photoClean);
    expect(again.status).toBe(200);
    expect(photosBucket.objects.size).toBe(before);
    const stolen = await upload(photoIds[0]!, other.bearer);
    expect([stolen.status, stolen.body.error?.code]).toEqual([403, "forbidden"]);
  });

  test("what isn't a JPEG is refused", async () => {
    const id = crypto.randomUUID();
    expect((await upload(id, rider.bearer, new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).status).toBe(422);
    expect((await upload(id, rider.bearer, photoClean, "image/png")).status).toBe(422);
    expect((await upload(id, rider.bearer, new Uint8Array(8 * 1024 * 1024 + 1))).status).toBe(422);
    expect((await upload("not-a-uuid", rider.bearer)).status).toBe(422);
    expect(await db.select().from(photoUpload).where(eq(photoUpload.id, id))).toEqual([]);
  });

  test("a submission waits for its photos, and names the missing ones", async () => {
    const { status, body } = await submit(crypto.randomUUID(), rider.bearer);
    expect([status, body.error?.code]).toEqual([422, "validation_failed"]);
    expect(body.error).toMatchObject({ details: { missingPhotos: [photoIds[1]] } });
  });

  test("a new spot is stored once per outbox id, cleaned up and filed under its city", async () => {
    await upload(photoIds[1]!, rider.bearer);
    const submissionId = crypto.randomUUID();
    const first = await read(SubmissionSchema, `/v1/submissions/${submissionId}`, {
      method: "PUT",
      headers: { ...rider.bearer, "content-type": "application/json" },
      body: JSON.stringify(draft()),
    });
    submissionIds.push(submissionId);
    expect(first).toMatchObject({
      id: submissionId,
      status: "pending",
      title: "Undercroft Ledges",
      obstacles: ["ledges", "banks"],
      cityId,
      note: "Busy on weekends",
      spotId: null,
      photos: [
        { photoId: photoIds[0], position: 0, width: 640, height: 480, credit: { takenBy: "submitter" } },
        { photoId: photoIds[1], position: 1, credit: { takenBy: "someone_else", credit: "@photographer", hasPermission: true, sourceUrl: "https://example.com/p/1" } },
      ],
    });

    expect((await submit(submissionId, rider.bearer)).status).toBe(200);
    const edited = await submit(submissionId, rider.bearer, draft({ title: "Undercroft", photos: draft().photos.slice(1) }));
    expect(edited.status).toBe(200);
    expect(SubmissionSchema.parse(edited.body.data)).toMatchObject({ title: "Undercroft", photos: [{ photoId: photoIds[1], position: 0 }] });
    expect(await db.select({ id: submission.id }).from(submission).where(eq(submission.id, submissionId))).toHaveLength(1);

    await db.update(submission).set({ status: "rejected", rejectReason: "duplicate", reviewedAt: new Date() }).where(eq(submission.id, submissionId));
    const late = await submit(submissionId, rider.bearer, draft({ title: "Changed after the decision" }));
    expect(SubmissionSchema.parse(late.body.data)).toMatchObject({ status: "rejected", rejectReason: "duplicate", title: "Undercroft" });
  });

  test("another person's photos or submission id are off limits", async () => {
    const theirPhoto = crypto.randomUUID();
    photoIds.push(theirPhoto);
    await upload(theirPhoto, other.bearer);
    const mine = crypto.randomUUID();
    const borrowed = await submit(mine, rider.bearer, draft({ photos: [{ photoId: theirPhoto, thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI", credit: { takenBy: "submitter" } }] }));
    expect(borrowed.body.error).toMatchObject({ code: "validation_failed", details: { missingPhotos: [theirPhoto] } });

    const theirs = crypto.randomUUID();
    await submit(theirs, other.bearer, draft({ photos: [{ photoId: theirPhoto, thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI", credit: { takenBy: "submitter" } }] }));
    const hijack = await submit(theirs, rider.bearer);
    expect([hijack.status, hijack.body.error?.code]).toEqual([403, "forbidden"]);
  });

  test("someone else's photo needs a credit and permission", async () => {
    const refused = await Promise.all(
      [
        { takenBy: "someone_else", credit: "@x" },
        { takenBy: "someone_else", credit: "@x", hasPermission: false },
        { takenBy: "someone_else", credit: " ", hasPermission: true },
        { takenBy: "nobody" },
      ].map(async (credit) => (await submit(crypto.randomUUID(), rider.bearer, draft({ photos: [{ photoId: photoIds[0], thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI", credit }] }))).status),
    );
    expect(refused).toEqual([422, 422, 422, 422]);
  });

  test("your submissions come back newest first, and only yours", async () => {
    const mine = await read(z.object({ submissions: z.array(SubmissionSchema) }), "/v1/me/submissions", { headers: rider.bearer });
    const theirs = await read(z.object({ submissions: z.array(SubmissionSchema) }), "/v1/me/submissions", { headers: other.bearer });
    expect(mine.submissions.map((row) => row.title)).toEqual(["Undercroft"]);
    expect(theirs.submissions).toHaveLength(1);
    expect(theirs.submissions[0]!.id).not.toBe(mine.submissions[0]!.id);
  });
});
