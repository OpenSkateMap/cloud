import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "@hono/zod-openapi";
import { type Database, openDatabase, schema } from "@openskatemap/db";
import { eq, inArray, sql } from "drizzle-orm";
import { MeSchema } from "../src/lib/me.ts";
import { BlockedUserSchema, PublicProfileSchema } from "../src/lib/people-schemas.ts";
import { SpotDetailsSchema } from "../src/lib/spot-schemas.ts";
import { saveCity } from "../src/services/cities.ts";
import { countingLimiter } from "../test/support.ts";
import { call, createRider, e2eUrl, photosBucket, read } from "./support.ts";

const { city, cityEditor, photoUpload, report, spot, spotPhoto, submission, submissionPhoto, user } = schema;
type Rider = Awaited<ReturnType<typeof createRider>>;

const segment = (marker: number, payload: number[]) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
const jpeg = new Uint8Array([0xff, 0xd8, ...segment(0xc0, [8, 0, 0x40, 0, 0x40, 1, 1, 0x11, 0]), 0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, 0x12, 0xff, 0xd9]);

describe.skipIf(!e2eUrl)("people (database)", () => {
  const database = e2eUrl ? openDatabase(e2eUrl) : undefined;
  const tag = crypto.randomUUID().slice(0, 8);
  const cityId = `e2e-city-${tag}`;
  const spotId = `e2e-${tag}-spot`;
  const avatarId = crypto.randomUUID();
  const submissionIds = [crypto.randomUUID(), crypto.randomUUID()];
  let db: Database;
  let rider: Rider, other: Rider, third: Rider;

  const profileOf = (userId: string, as: Rider) => call(`/v1/users/${userId}`, { headers: as.bearer });
  const patch = (body: unknown, as: Rider = rider) =>
    call("/v1/me/profile", { method: "PATCH", headers: { ...as.bearer, "content-type": "application/json" }, body: JSON.stringify(body) });
  const send = (method: string, path: string, as: Rider, body?: unknown) =>
    call(path, { method, headers: { ...as.bearer, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  beforeAll(async () => {
    db = (await database!).db;
    [rider, other, third] = [await createRider(db, "Rider"), await createRider(db, "Other"), await createRider(db, "Third")];
    await db.insert(city).values({ id: cityId, slug: `e2e-${tag}`, name: `E2E ${tag}`, countryCode: "GB", area: sql`ST_Multi(ST_MakeEnvelope(-0.125, 51.50, -0.105, 51.51, 4326))` });
    await db.insert(spot).values({ id: spotId, title: "Rider's spot", kind: "street", location: { latitude: 51.505, longitude: -0.115 }, createdBy: rider.userId });
    const base = { kind: "new_spot" as const, title: "x", spotKind: "street" as const, location: { latitude: 51.505, longitude: -0.115 }, submittedBy: rider.userId };
    await db.insert(submission).values([
      { ...base, id: submissionIds[0]!, status: "approved", spotId, reviewedAt: new Date() },
      { ...base, id: submissionIds[1]! },
    ]);
  });

  afterAll(async () => {
    await db.delete(submission).where(inArray(submission.id, submissionIds));
    await db.delete(spot).where(eq(spot.id, spotId));
    await db.delete(photoUpload).where(eq(photoUpload.id, avatarId));
    await db.delete(city).where(eq(city.id, cityId));
    await db.delete(user).where(inArray(user.id, [rider.userId, other.userId, third.userId]));
    await (await database!).close();
  });

  test("riders sharing an address each spend their own account's API budget", async () => {
    const api = { API_LIMITER: countingLimiter(2) };
    const sameAddress = (as: Rider) => call("/v1/me", { headers: { ...as.bearer, "cf-connecting-ip": "203.0.113.7" } }, api);
    expect([(await sameAddress(rider)).status, (await sameAddress(rider)).status]).toEqual([200, 200]);
    const over = await sameAddress(rider);
    expect([over.status, over.body.error?.code, over.headers.get("Retry-After")]).toEqual([429, "rate_limited", "60"]);
    expect((await sameAddress(other)).status).toBe(200);
    expect([...api.API_LIMITER.counts.keys()]).toEqual([`account:${rider.userId}`, `account:${other.userId}`]);
  });

  test("a profile starts empty, with contribution stats and no email", async () => {
    const { status, body } = await profileOf(rider.userId, other);
    expect(status).toBe(200);
    expect(body.data).not.toHaveProperty("email");
    expect(PublicProfileSchema.parse(body.data)).toMatchObject({
      id: rider.userId,
      name: "Rider",
      username: null,
      bio: "",
      avatar: null,
      handles: { instagram: null, website: null },
      role: "user",
      editorOf: [],
      stats: { submitted: 2, approved: 1, cities: 1 },
      blockedByMe: false,
    });
    expect((await profileOf("nobody-at-all", other)).status).toBe(404);
  });

  test("a profile and the account both say when the account was created", async () => {
    const [created] = await db.select({ at: user.createdAt }).from(user).where(eq(user.id, rider.userId));
    const createdAt = created!.at.toISOString();
    expect(PublicProfileSchema.parse((await profileOf(rider.userId, other)).body.data).joinedAt).toBe(createdAt);
    expect(MeSchema.parse((await call("/v1/me", { headers: rider.bearer })).body.data).createdAt).toBe(createdAt);
  });

  test("cities count where approved spots are now, including a city drawn after the approval", async () => {
    const lateSpotId = `e2e-${tag}-late-spot`;
    const lateSubmissionId = crypto.randomUUID();
    const lateSlug = `e2e-late-${tag}`;
    const location = { latitude: -45.505, longitude: 170.505 };
    await db.insert(spot).values({ id: lateSpotId, title: "Far spot", kind: "street", location, createdBy: third.userId });
    await db.insert(submission).values({ id: lateSubmissionId, kind: "new_spot", title: "Far spot", spotKind: "street", location, submittedBy: third.userId, status: "approved", spotId: lateSpotId, reviewedAt: new Date() });
    const cities = async () => PublicProfileSchema.parse((await profileOf(third.userId, other)).body.data).stats.cities;
    try {
      expect(await cities()).toBe(0);
      await saveCity(db, { slug: lateSlug, name: `E2E late ${tag}`, countryCode: "NZ", bbox: [170.5, -45.51, 170.51, -45.5] });
      expect(await cities()).toBe(1);
    } finally {
      await db.delete(submission).where(eq(submission.id, lateSubmissionId));
      await db.delete(spot).where(eq(spot.id, lateSpotId));
      await db.delete(city).where(eq(city.slug, lateSlug));
    }
  });

  test("you change only what you send, and handles are cleaned up", async () => {
    const updated = await patch({ name: "Rider Two", username: "  Rider_Two ", bio: "Ledges.", handles: { instagram: "@rider_two", website: "https://rider.example" } });
    expect(PublicProfileSchema.parse(updated.body.data)).toMatchObject({ name: "Rider Two", username: "Rider_Two", bio: "Ledges.", handles: { instagram: "rider_two", website: "https://rider.example", x: null } });
    const cleared = PublicProfileSchema.parse((await patch({ clear: ["instagram", "bio"] })).body.data);
    expect(cleared).toMatchObject({ username: "Rider_Two", bio: "", handles: { instagram: null, website: "https://rider.example" } });
    expect((await patch({ bio: "Ledges.", clear: ["bio"] })).status).toBe(422);
    expect((await patch({ handles: { x: "rider" }, clear: ["x"] })).status).toBe(422);
    expect((await patch({ clear: ["name"] })).status).toBe(422);
  });

  test("bad usernames and handles are refused; a taken or disallowed username is a conflict", async () => {
    const refused = await Promise.all(
      [{ username: "abcd" }, { username: "rider.two" }, { username: "no spaces" }, { username: "skate🛹" }, { handles: { x: "far_too_long_for_x_handles" } }, { handles: { website: "ftp://x.example" } }].map(
        async (body) => (await patch(body)).status,
      ),
    );
    expect(refused).toEqual([422, 422, 422, 422, 422, 422]);
    const taken = await patch({ username: "RIDER_TWO" }, other);
    expect([taken.status, taken.body.error?.code]).toEqual([409, "conflict"]);
    const disallowed = await patch({ username: "NikeSB_official" }, other);
    expect([disallowed.status, disallowed.body.error?.code]).toEqual([409, "conflict"]);
  });

  test("an avatar must be your own upload", async () => {
    expect((await patch({ avatar: { photoId: avatarId, thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI" } })).status).toBe(422);
    await call(`/v1/photos/${avatarId}`, { method: "PUT", headers: { ...rider.bearer, "content-type": "image/jpeg" }, body: jpeg });
    const withAvatar = PublicProfileSchema.parse((await patch({ avatar: { photoId: avatarId, thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI" } })).body.data);
    expect(withAvatar.avatar?.key).toMatch(/^photos\//);
    expect((await patch({ avatar: { photoId: avatarId, thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI" } }, other)).status).toBe(422);
    expect(PublicProfileSchema.parse((await patch({ clear: ["avatar"] })).body.data).avatar).toBeNull();
    await patch({ avatar: { photoId: avatarId, thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI" } });
  });

  test("editors show the cities they review", async () => {
    await db.update(user).set({ role: "editor" }).where(eq(user.id, rider.userId));
    await db.insert(cityEditor).values({ cityId, userId: rider.userId });
    const profile = PublicProfileSchema.parse((await profileOf(rider.userId, other)).body.data);
    expect(profile).toMatchObject({ role: "editor", editorOf: [{ id: cityId, name: `E2E ${tag}` }] });
  });

  test("blocking hides the blocker's profile from the blocked, and the blocked from spots the blocker opens", async () => {
    expect((await send("PUT", `/v1/me/blocks/${rider.userId}`, other)).status).toBe(200);
    expect((await send("PUT", `/v1/me/blocks/${rider.userId}`, other)).status).toBe(200);
    expect((await send("PUT", `/v1/me/blocks/${other.userId}`, other)).status).toBe(422);
    expect((await send("PUT", "/v1/me/blocks/nobody-at-all", other)).status).toBe(404);

    expect((await profileOf(other.userId, rider)).status).toBe(404);
    expect(PublicProfileSchema.parse((await profileOf(rider.userId, other)).body.data).blockedByMe).toBe(true);
    const blocked = await read(z.object({ users: z.array(BlockedUserSchema) }), "/v1/me/blocks", { headers: other.bearer });
    expect(blocked.users.map((row) => [row.id, row.username])).toEqual([[rider.userId, "Rider_Two"]]);

    await db.insert(spotPhoto).values({ id: `${spotId}-photo`, spotId, r2Key: "photos/x.jpg", width: 1, height: 1, thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI", credit: null, hasPermission: true, uploadedBy: rider.userId, position: 0 });
    const forBlocker = await read(SpotDetailsSchema, `/v1/spots?ids=${spotId}`, { headers: other.bearer });
    const forThird = await read(SpotDetailsSchema, `/v1/spots?ids=${spotId}`, { headers: third.bearer });
    expect(forBlocker.spots[0]).toMatchObject({ addedBy: null, photos: [{ credit: null }] });
    expect(forThird.spots[0]).toMatchObject({ addedBy: { id: rider.userId, name: "Rider Two" }, photos: [{ credit: "Rider Two" }] });

    expect((await send("DELETE", `/v1/me/blocks/${rider.userId}`, other)).body.data).toEqual({ blocked: false });
    expect((await profileOf(other.userId, rider)).status).toBe(200);
  });

  test("deleting an account deletes its unused photos and keeps the submitted ones", async () => {
    const leaving = await createRider(db, "Leaving");
    const [avatar, unused, submitted] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    for (const photoId of [avatar, unused, submitted]) {
      await call(`/v1/photos/${photoId}`, { method: "PUT", headers: { ...leaving.bearer, "content-type": "image/jpeg" }, body: jpeg });
    }
    await patch({ avatar: { photoId: avatar, thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI" } }, leaving);
    const kept = crypto.randomUUID();
    submissionIds.push(kept);
    await db.insert(submission).values({ id: kept, kind: "new_spot", title: "x", spotKind: "street", location: { latitude: 51.505, longitude: -0.115 }, submittedBy: leaving.userId });
    await db.insert(submissionPhoto).values({ submissionId: kept, photoId: submitted, position: 0, thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI", hasPermission: true });
    const keys = Object.fromEntries(
      (await db.select({ id: photoUpload.id, r2Key: photoUpload.r2Key }).from(photoUpload).where(inArray(photoUpload.id, [avatar, unused, submitted]))).map((row) => [row.id, row.r2Key]),
    );

    expect((await send("DELETE", "/v1/me", leaving)).status).toBe(200);
    const left = await db.select({ id: photoUpload.id, uploadedBy: photoUpload.uploadedBy }).from(photoUpload).where(inArray(photoUpload.id, [avatar, unused, submitted]));
    expect(left).toEqual([{ id: submitted, uploadedBy: null }]);
    expect([avatar, unused, submitted].map((photoId) => photosBucket.objects.has(keys[photoId]!))).toEqual([false, false, true]);
    await db.delete(photoUpload).where(eq(photoUpload.id, submitted));
  });

  test("reports reach the admins for spots and people that exist", async () => {
    const filed = await send("POST", "/v1/reports", third, { targetKind: "spot", targetId: spotId, reason: "private_property", message: "Backyard" });
    expect(filed.status).toBe(200);
    const [row] = await db.select().from(report).where(eq(report.id, String(filed.body.data?.id)));
    expect(row).toMatchObject({ reporterId: third.userId, targetKind: "spot", targetId: spotId, reason: "private_property", message: "Backyard", status: "open" });
    await db.delete(report).where(eq(report.id, String(filed.body.data?.id)));

    expect((await send("POST", "/v1/reports", third, { targetKind: "spot", targetId: "no-such-spot", reason: "spam" })).status).toBe(404);
    expect((await send("POST", "/v1/reports", third, { targetKind: "user", targetId: third.userId, reason: "spam" })).status).toBe(422);
    expect((await send("POST", "/v1/reports", third, { targetKind: "user", targetId: rider.userId, reason: "boring" })).status).toBe(422);
  });
});
