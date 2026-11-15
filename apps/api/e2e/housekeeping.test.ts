import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Database, openDatabase, schema } from "@openskatemap/db";
import { eq, inArray } from "drizzle-orm";
import { sweep } from "../src/services/housekeeping.ts";
import { createRider, e2eUrl } from "./support.ts";

const { collection, photoUpload, profile, session, submission, submissionPhoto, user } = schema;

describe.skipIf(!e2eUrl)("housekeeping (database)", () => {
  const database = e2eUrl ? openDatabase(e2eUrl) : undefined;
  const DAY = 86_400_000;
  const now = new Date();
  const ids = { unused: crypto.randomUUID(), submitted: crypto.randomUUID(), avatar: crypto.randomUUID(), cover: crypto.randomUUID(), fresh: crypto.randomUUID() };
  const submissionId = crypto.randomUUID();
  let db: Database;
  let rider: Awaited<ReturnType<typeof createRider>>;

  beforeAll(async () => {
    db = (await database!).db;
    rider = await createRider(db, "Sweeper");
    const old = new Date(now.getTime() - 8 * DAY);
    await db.insert(photoUpload).values(
      Object.entries(ids).map(([name, id]) => ({ id, uploadedBy: rider.userId, r2Key: `photos/${id}.jpg`, bytes: 1000, width: 800, height: 600, createdAt: name === "fresh" ? now : old })),
    );
    await db.insert(submission).values({ id: submissionId, kind: "new_spot", submittedBy: rider.userId, title: "Kept", spotKind: "street", location: { latitude: -80, longitude: 0 } });
    await db.insert(submissionPhoto).values({ submissionId, photoId: ids.submitted, position: 0, thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI", hasPermission: true });
    await db.insert(profile).values({ userId: rider.userId, avatarPhotoId: ids.avatar, avatarThumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI" });
    await db.insert(collection).values({ id: crypto.randomUUID(), ownerId: rider.userId, name: "Covered", photoId: ids.cover, photoThumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI" });
    await db.insert(session).values([
      { id: `expired-${rider.userId}`, token: crypto.randomUUID(), userId: rider.userId, expiresAt: new Date(now.getTime() - DAY), createdAt: old, updatedAt: old },
    ]);
  });

  afterAll(async () => {
    await db.delete(submission).where(eq(submission.id, submissionId));
    await db.delete(user).where(eq(user.id, rider.userId));
    await db.delete(photoUpload).where(inArray(photoUpload.id, Object.values(ids)));
    await (await database!).close();
  });

  test("a week-old upload nothing uses goes, with expired sessions; used and new ones stay", async () => {
    const swept = await sweep(db, now);
    expect(swept.photoKeys).toContain(`photos/${ids.unused}.jpg`);
    expect(swept.sessions).toBeGreaterThanOrEqual(1);
    const left = await db.select({ id: photoUpload.id }).from(photoUpload).where(inArray(photoUpload.id, Object.values(ids)));
    expect(left.map((row) => row.id).toSorted()).toEqual([ids.submitted, ids.avatar, ids.cover, ids.fresh].toSorted());
    expect(await db.select({ id: session.id }).from(session).where(eq(session.userId, rider.userId))).toEqual([{ id: `s-${rider.userId}` }]);
  });
});
