import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openDatabase, schema } from "@openskatemap/db";
import { eq, inArray } from "drizzle-orm";
import { APPLE_ACCOUNT_GRACE_DAYS, applyAppleAccountEvent, cancelAppleAccountDeletion, deleteDueAccounts } from "../src/services/apple-account-events.ts";
import { call, createRider, e2eUrl, photosBucket } from "./support.ts";

describe.skipIf(!e2eUrl)("account (database)", () => {
  const database = e2eUrl ? openDatabase(e2eUrl) : undefined;
  let userId = "";
  let bearer = { authorization: "" };

  beforeAll(async () => {
    ({ userId, bearer } = await createRider((await database!).db));
  });

  afterAll(async () => {
    const session = await database!;
    await session.db.delete(schema.user).where(eq(schema.user.id, userId));
    await session.close();
  });

  test("revoking Sign in with Apple ends the sessions from before it, not a sign-in after", async () => {
    const { db } = await database!;
    const rider = await createRider(db, "Revoking");
    const appleUserId = `000${crypto.randomUUID()}.0219`;
    const revokedAt = new Date();
    const now = new Date(revokedAt.getTime() + 1000);
    await db.insert(schema.account).values({ id: `a-${rider.userId}`, accountId: appleUserId, providerId: "apple", userId: rider.userId, createdAt: now, updatedAt: now });
    await db.update(schema.session).set({ createdAt: new Date(revokedAt.getTime() - 60_000) }).where(eq(schema.session.userId, rider.userId));
    await db.insert(schema.appleToken).values({ userId: rider.userId, clientId: "com.ertembiyik.openskatemap", refreshToken: "sealed", updatedAt: new Date(revokedAt.getTime() - 60_000) });
    const later = crypto.randomUUID().replaceAll("-", "");
    await db.insert(schema.session).values({ id: `s2-${rider.userId}`, token: later, userId: rider.userId, expiresAt: new Date(now.getTime() + 3_600_000), createdAt: now, updatedAt: now });

    expect(await applyAppleAccountEvent(db, { type: "email-disabled", appleUserId, at: revokedAt })).toBe("ignored");
    expect((await call("/v1/me", { headers: rider.bearer })).status).toBe(200);
    expect(await applyAppleAccountEvent(db, { type: "consent-revoked", appleUserId, at: revokedAt })).toBe("signed-out");
    expect((await call("/v1/me", { headers: rider.bearer })).status).toBe(401);
    expect((await call("/v1/me", { headers: { authorization: `Bearer ${later}` } })).status).toBe(200);
    expect(await db.select().from(schema.appleToken).where(eq(schema.appleToken.userId, rider.userId))).toEqual([]);
    expect(await applyAppleAccountEvent(db, { type: "consent-revoked", appleUserId: "000unknown.0219", at: revokedAt })).toBe("unknown-account");
    await db.delete(schema.user).where(eq(schema.user.id, rider.userId));
  });

  test("a deleted Apple Account deletes ours after the grace period, unless they signed in since or sign in again", async () => {
    const { db } = await database!;
    const link = async (rider: Awaited<ReturnType<typeof createRider>>) => {
      const appleUserId = `000${crypto.randomUUID()}.0219`;
      await db.insert(schema.account).values({ id: `a-${rider.userId}`, accountId: appleUserId, providerId: "apple", userId: rider.userId, createdAt: new Date(), updatedAt: new Date() });
      await db.update(schema.session).set({ createdAt: new Date(Date.now() - 60_000) }).where(eq(schema.session.userId, rider.userId));
      return appleUserId;
    };
    const deletionOf = async (userId: string) =>
      (await db.select().from(schema.appleAccountDeletion).where(eq(schema.appleAccountDeletion.userId, userId)))[0];
    const [gone, back, fresh, racing] = [
      await createRider(db, "Gone"),
      await createRider(db, "Back"),
      await createRider(db, "Fresh"),
      await createRider(db, "Racing"),
    ];
    const at = new Date();
    const later = new Date(at.getTime() + 1000);

    expect(await applyAppleAccountEvent(db, { type: "account-delete", appleUserId: await link(gone), at })).toBe("deletion-scheduled");
    expect(await applyAppleAccountEvent(db, { type: "account-deleted", appleUserId: await link(back), at })).toBe("deletion-scheduled");
    expect(await applyAppleAccountEvent(db, { type: "account-delete", appleUserId: await link(racing), at })).toBe("deletion-scheduled");
    // Signed in again, but the cancel hasn't run yet.
    await db.insert(schema.session).values({ id: `s4-${racing.userId}`, token: crypto.randomUUID(), userId: racing.userId, expiresAt: new Date(later.getTime() + 3_600_000), createdAt: later, updatedAt: later });
    const freshApple = await link(fresh);
    await db.insert(schema.session).values({ id: `s3-${fresh.userId}`, token: crypto.randomUUID(), userId: fresh.userId, expiresAt: new Date(later.getTime() + 3_600_000), createdAt: later, updatedAt: later });
    expect(await applyAppleAccountEvent(db, { type: "account-delete", appleUserId: freshApple, at })).toBe("signed-out");

    expect((await deletionOf(gone.userId))?.dueAt).toEqual(new Date(at.getTime() + APPLE_ACCOUNT_GRACE_DAYS * 86_400_000));
    expect(await deletionOf(fresh.userId)).toBeUndefined();
    await cancelAppleAccountDeletion(db, back.userId);
    expect(await deletionOf(back.userId)).toBeUndefined();

    const dayBefore = new Date(at.getTime() + (APPLE_ACCOUNT_GRACE_DAYS - 1) * 86_400_000);
    expect(await deleteDueAccounts(db, photosBucket, dayBefore)).not.toContain(gone.userId);
    const dueDay = new Date(at.getTime() + APPLE_ACCOUNT_GRACE_DAYS * 86_400_000);
    const deleted = await deleteDueAccounts(db, photosBucket, dueDay);
    expect(deleted).toContain(gone.userId);
    expect(deleted).not.toContain(racing.userId);
    expect(await db.select().from(schema.user).where(eq(schema.user.id, gone.userId))).toEqual([]);
    expect((await db.select().from(schema.user).where(eq(schema.user.id, back.userId))).length).toBe(1);
    expect((await db.select().from(schema.user).where(eq(schema.user.id, racing.userId))).length).toBe(1);
    await db.delete(schema.user).where(inArray(schema.user.id, [back.userId, fresh.userId, racing.userId]));
  });

  test("a notice that isn't Apple's is refused before it touches anything", async () => {
    const { status, body } = await call("/v1/auth/apple/notifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: "eyJhbGciOiJub25lIn0.eyJldmVudHMiOnt9fQ." }),
    });
    expect([status, body.error?.code]).toEqual([403, "forbidden"]);
  });

  test("a forged Apple identity token is refused", async () => {
    const { status, body } = await call("/v1/auth/apple", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken: "not-a-jwt", nonce: "0123456789abcdef0123" }),
    });
    expect(status).toBe(401);
    expect(body.error?.code).toBe("auth_required");
  });

  test("a live session reads its own account", async () => {
    const { status, body } = await call("/v1/me", { headers: bearer });
    expect(status).toBe(200);
    expect(body.data).toMatchObject({ id: userId, name: "E2E Rider", role: "user" });
  });

  test("a banned account is refused even with a live session", async () => {
    const { db } = await database!;
    await db.update(schema.user).set({ banned: true }).where(eq(schema.user.id, userId));
    const { status, body } = await call("/v1/me", { headers: bearer });
    await db.update(schema.user).set({ banned: false }).where(eq(schema.user.id, userId));
    expect(status).toBe(403);
    expect(body.error?.code).toBe("forbidden");
  });

  test("signing out ends the session", async () => {
    expect((await call("/v1/auth/logout", { method: "POST", headers: bearer })).status).toBe(200);
    const { status, body } = await call("/v1/me", { headers: bearer });
    expect(status).toBe(401);
    expect(body.error?.code).toBe("auth_required");
  });

  test("deleting the account removes it and every session", async () => {
    const { db } = await database!;
    const second = crypto.randomUUID().replaceAll("-", "");
    const now = new Date();
    await db.insert(schema.session).values({ id: `s2-${userId}`, token: second, userId, expiresAt: new Date(now.getTime() + 3_600_000), createdAt: now, updatedAt: now });
    const photoId = crypto.randomUUID();
    await db.insert(schema.photoUpload).values({ id: photoId, uploadedBy: userId, r2Key: `photos/${photoId}.jpg`, bytes: 1000, width: 800, height: 600 });
    await db.insert(schema.collection).values({ id: crypto.randomUUID(), ownerId: userId, name: "Mine", photoId, photoThumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI" });
    const avatarId = crypto.randomUUID();
    await db.insert(schema.photoUpload).values({ id: avatarId, uploadedBy: userId, r2Key: `photos/${avatarId}.jpg`, bytes: 1000, width: 400, height: 400 });
    await db.insert(schema.profile).values({ userId, avatarPhotoId: avatarId, avatarThumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI" });
    const clipId = crypto.randomUUID();
    await db.insert(schema.clipUpload).values({ id: clipId, uploadedBy: userId, r2Key: `clips/${clipId}.mp4`, bytes: 1000, width: 96, height: 64, durationMs: 2000 });
    const deleted = await call("/v1/me", { method: "DELETE", headers: { authorization: `Bearer ${second}` } });
    expect(deleted.status).toBe(200);
    expect(await db.select().from(schema.user).where(eq(schema.user.id, userId))).toEqual([]);
    expect(await db.select().from(schema.session).where(eq(schema.session.userId, userId))).toEqual([]);
    expect(await db.select().from(schema.photoUpload).where(inArray(schema.photoUpload.id, [photoId, avatarId]))).toEqual([]);
    expect(await db.select().from(schema.clipUpload).where(eq(schema.clipUpload.id, clipId))).toEqual([]);
  });
});
