import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Database, openDatabase, schema } from "@openskatemap/db";
import { z } from "@hono/zod-openapi";
import { eq, inArray } from "drizzle-orm";
import { PublicProfileSchema } from "../src/lib/people-schemas.ts";
import { SpotDetailsSchema, SpotRemovalSchema, SyncPageSchema } from "../src/lib/spot-schemas.ts";
import { SubmissionSchema } from "../src/lib/submission-schemas.ts";
import { call, createRider, e2eUrl, read } from "./support.ts";

const { reviewEvent, spot, submission, user } = schema;

type Rider = Awaited<ReturnType<typeof createRider>>;

describe.skipIf(!e2eUrl)("taking a spot down and restoring it (database)", () => {
  const database = e2eUrl ? openDatabase(e2eUrl) : undefined;
  const tag = crypto.randomUUID().slice(0, 8);
  const ids = {
    synced: `e2e-removal-${tag}-synced`,
    open: `e2e-removal-${tag}-open`,
    hidden: `e2e-removal-${tag}-private`,
    undone: `e2e-removal-${tag}-undone`,
  };
  const submissionIds = { approved: crypto.randomUUID(), undone: crypto.randomUUID() };
  let db: Database;
  let admin: Rider, editor: Rider, plain: Rider;

  const takeDown = (spotId: string, as: Rider, reason: unknown = "duplicate") =>
    call(`/v1/spots/${spotId}/removal`, {
      method: "PUT",
      headers: { ...as.bearer, "content-type": "application/json" },
      body: JSON.stringify({ reason }),
    });
  const restore = (spotId: string, as: Rider) => call(`/v1/spots/${spotId}/removal`, { method: "DELETE", headers: as.bearer });
  const stateOf = async (spotId: string) =>
    (await db.select({ status: spot.status, reason: spot.removalReason, version: spot.version }).from(spot).where(eq(spot.id, spotId)))[0]!;
  const events = async (spotId: string) =>
    db.select({ action: reviewEvent.action, details: reviewEvent.details }).from(reviewEvent).where(eq(reviewEvent.spotId, spotId)).orderBy(reviewEvent.id);
  const history = async (as: Rider) =>
    (await read(z.object({ submissions: z.array(SubmissionSchema) }), "/v1/me/submissions", { headers: as.bearer })).submissions;

  beforeAll(async () => {
    db = (await database!).db;
    [admin, editor, plain] = [await createRider(db, "Admin"), await createRider(db, "Editor"), await createRider(db, "Plain")];
    await db.update(user).set({ role: "admin" }).where(eq(user.id, admin.userId));
    await db.update(user).set({ role: "editor" }).where(eq(user.id, editor.userId));
    const location = { latitude: 38.72, longitude: -9.15 };
    // An app that has synced holds a cursor above 0; from 0 the sync sends no tombstones, and an empty table's first version is 1.
    await db.insert(spot).values({ id: ids.synced, title: "Already Synced", kind: "street", location });
    await db.insert(spot).values([
      { id: ids.open, title: "Open", kind: "plaza", location },
      { id: ids.hidden, title: "Backyard", kind: "diy", visibility: "private", createdBy: plain.userId, location },
      { id: ids.undone, title: "Undone", kind: "street", status: "removed", location },
    ]);
    const base = { kind: "new_spot" as const, title: "Open", spotKind: "plaza" as const, location, submittedBy: plain.userId };
    await db.insert(submission).values([
      { ...base, id: submissionIds.approved, status: "approved", reviewedAt: new Date(), spotId: ids.open },
      { ...base, id: submissionIds.undone, title: "Undone", spotId: ids.undone },
    ]);
  });

  afterAll(async () => {
    await db.delete(submission).where(inArray(submission.id, Object.values(submissionIds)));
    await db.delete(spot).where(inArray(spot.id, Object.values(ids)));
    await db.delete(user).where(inArray(user.id, [admin, editor, plain].map((rider) => rider.userId)));
  });

  test("only admins take a spot down, with a known reason", async () => {
    expect((await takeDown(ids.open, editor)).status).toBe(403);
    expect((await takeDown(ids.hidden, plain)).status).toBe(403);
    expect((await takeDown(ids.open, admin, "boring")).status).toBe(422);
    expect((await stateOf(ids.open)).status).toBe("published");
  });

  test("a takedown reaches apps as a tombstone and is recorded once, with its reason", async () => {
    const { version } = await stateOf(ids.open);

    const first = await takeDown(ids.open, admin, "private_property");
    const again = await takeDown(ids.open, admin, "duplicate");

    expect(first.status).toBe(200);
    const removal = SpotRemovalSchema.parse(first.body.data);
    expect(removal.reason).toBe("private_property");
    expect(SpotRemovalSchema.parse(again.body.data)).toEqual(removal);
    expect(await stateOf(ids.open)).toMatchObject({ status: "removed", reason: "private_property" });
    expect(await events(ids.open)).toEqual([{ action: "remove", details: { reason: "private_property", visibility: "public" } }]);
    const page = await read(SyncPageSchema, `/v1/sync/spots?cursor=${version - 1}`, { headers: plain.bearer });
    expect(page.tombstones).toContain(ids.open);
    const details = await read(SpotDetailsSchema, `/v1/spots?ids=${ids.open}`, { headers: plain.bearer });
    expect(details.missing).toEqual([ids.open]);
  });

  test("the submitter's history keeps the row and says why; stats leave it out", async () => {
    const rows = await history(plain);
    const profile = await read(PublicProfileSchema, `/v1/users/${plain.userId}`, { headers: plain.bearer });

    expect(rows.find((row) => row.id === submissionIds.approved)).toMatchObject({ status: "approved", removal: { reason: "private_property" } });
    expect(rows.find((row) => row.id === submissionIds.undone)).toMatchObject({ status: "pending", removal: null });
    expect(profile.stats).toEqual({ submitted: 1, approved: 0, cities: 0 });
  });

  test("restoring puts it back under a new version; restoring again changes nothing", async () => {
    const { version } = await stateOf(ids.open);

    expect((await restore(ids.open, editor)).status).toBe(403);
    expect((await restore(ids.open, admin)).status).toBe(200);
    expect((await restore(ids.open, admin)).status).toBe(200);

    const restored = await stateOf(ids.open);
    expect(restored).toMatchObject({ status: "published", reason: null });
    expect(restored.version).toBeGreaterThan(version);
    expect((await events(ids.open)).map((event) => event.action)).toEqual(["remove", "restore"]);
    const page = await read(SyncPageSchema, `/v1/sync/spots?cursor=${version}`, { headers: plain.bearer });
    expect(page.items.map((row) => row.id)).toContain(ids.open);
    expect((await history(plain)).find((row) => row.id === submissionIds.approved)?.removal).toBeNull();
  });

  test("undoing the approval of a taken-down spot supersedes the takedown", async () => {
    expect((await takeDown(ids.open, admin, "unsafe_or_gone")).status).toBe(200);

    const undone = await call(`/v1/review/${submissionIds.approved}/undo`, { method: "POST", headers: admin.bearer });

    expect(undone.status).toBe(200);
    expect(await stateOf(ids.open)).toMatchObject({ status: "removed", reason: null });
    expect((await restore(ids.open, admin)).status).toBe(409);
    expect((await history(plain)).find((row) => row.id === submissionIds.approved)).toMatchObject({ status: "pending", removal: null });
  });

  test("a spot removed by an undone approval is neither taken down nor restored", async () => {
    expect((await takeDown(ids.undone, admin)).status).toBe(404);
    expect((await restore(ids.undone, admin)).status).toBe(409);
  });

  test("a private spot comes down too, and an unknown one is not found", async () => {
    expect((await takeDown(ids.hidden, admin, "other")).status).toBe(200);
    expect((await stateOf(ids.hidden)).status).toBe("removed");
    expect((await takeDown(`e2e-removal-${tag}-unknown`, admin)).status).toBe(404);
    expect((await restore(`e2e-removal-${tag}-unknown`, admin)).status).toBe(404);
  });
});
