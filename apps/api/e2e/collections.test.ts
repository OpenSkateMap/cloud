import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Database, openDatabase, schema } from "@openskatemap/db";
import { eq, inArray, sql } from "drizzle-orm";
import {
  CollectionAccessSchema,
  CollectionPageSchema,
  CollectionSchema,
  CollectionSpotsPageSchema,
  CollectionsSnapshotSchema,
} from "../src/lib/collection-schemas.ts";
import { SpotDetailsSchema, SyncPageSchema } from "../src/lib/spot-schemas.ts";
import { ReviewQueueSchema, SubmissionSchema } from "../src/lib/submission-schemas.ts";
import { PublicProfileSchema } from "../src/lib/people-schemas.ts";
import { reviewResultNotice } from "../src/services/notifications.ts";
import { z } from "@hono/zod-openapi";
import { countingLimiter } from "../test/support.ts";
import { call, createRider, e2eUrl, read } from "./support.ts";

const { collection, collectionSpot, photoUpload, profile, spot, submission, user, userBlock } = schema;

type Rider = Awaited<ReturnType<typeof createRider>>;

describe.skipIf(!e2eUrl)("collections and private spots (database)", () => {
  const database = e2eUrl ? openDatabase(e2eUrl) : undefined;
  const tag = crypto.randomUUID().slice(0, 8);
  const publicSpot = `e2e-spot-${tag}-public`;
  const photoId = crypto.randomUUID();
  let db: Database;
  let owner: Rider, friend: Rider, stranger: Rider, invitee: Rider;
  const created: string[] = [];

  const json = (as: Rider, method: string, body?: unknown): RequestInit => ({
    method,
    headers: { ...as.bearer, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const saveCollection = async (as: Rider, visibility: "private" | "public", name = "Night spots") => {
    const id = crypto.randomUUID();
    created.push(id);
    const saved = await read(CollectionSchema, `/v1/collections/${id}`, json(as, "PUT", { name, visibility }));
    return saved;
  };
  const snapshot = (as: Rider) => read(CollectionsSnapshotSchema, "/v1/me/collections", { headers: as.bearer });
  const details = (as: Rider, ids: string[]) => read(SpotDetailsSchema, `/v1/spots?ids=${ids.join(",")}`, { headers: as.bearer });
  const syncedIds = async (as: Rider) => {
    const ids: string[] = [];
    let cursor = 0;
    for (;;) {
      const page = await read(SyncPageSchema, `/v1/sync/spots?cursor=${cursor}&limit=500`, { headers: as.bearer });
      ids.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      if (!page.hasMore) return ids;
    }
  };
  const privateSpot = async (as: Rider, collectionId: string, photo = photoId) => {
    const submissionId = crypto.randomUUID();
    const saved = await read(
      SubmissionSchema,
      `/v1/submissions/${submissionId}`,
      json(as, "PUT", {
        kind: "new_spot",
        title: "Garage ledge",
        spotKind: "diy",
        latitude: 51.52,
        longitude: -0.1,
        collectionId,
        photos: [{ photoId: photo, thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI", credit: { takenBy: "submitter" } }],
      }),
    );
    return saved;
  };

  beforeAll(async () => {
    db = (await database!).db;
    [owner, friend, stranger, invitee] = [
      await createRider(db, "Owner"),
      await createRider(db, "Friend"),
      await createRider(db, "Stranger"),
      await createRider(db, "Invitee"),
    ];
    await db.insert(profile).values({ userId: friend.userId, username: `friend_${tag}` });
    await db.insert(spot).values({ id: publicSpot, title: "Undercroft", kind: "plaza", location: { latitude: 51.5066, longitude: -0.1169 } });
    await db.insert(photoUpload).values({ id: photoId, uploadedBy: owner.userId, r2Key: `photos/${photoId}.jpg`, bytes: 1000, width: 800, height: 600 });
  });

  afterAll(async () => {
    const madeSpots = await db.select({ id: submission.spotId }).from(submission).where(inArray(submission.submittedBy, [owner.userId]));
    await db.delete(collection).where(inArray(collection.id, created));
    await db.delete(submission).where(eq(submission.submittedBy, owner.userId));
    await db.delete(spot).where(inArray(spot.id, [publicSpot, ...madeSpots.flatMap((row) => (row.id ? [row.id] : []))]));
    await db.delete(photoUpload).where(eq(photoUpload.id, photoId));
    await db.delete(user).where(inArray(user.id, [owner, friend, stranger, invitee].map((rider) => rider.userId)));
    await (await database!).close();
  });

  test("a collection's spots page by an opaque cursor, newest added first, ties included, with the same access", async () => {
    const shelf = await saveCollection(owner, "public", "Paged");
    const spotIds = ["a", "b", "c", "d", "e"].map((name) => `e2e-spot-${tag}-page-${name}`);
    await db.insert(spot).values(spotIds.map((id, index) => ({ id, title: `Page ${index}`, kind: "street" as const, location: { latitude: 51.5, longitude: -0.1 + index / 1000 } })));
    try {
      // c, d and e at one microsecond, so a page boundary falls between equal timestamps; b at that millisecond,
      // which a cursor cut to milliseconds would mistake for them.
      await db.insert(collectionSpot).values([
        { collectionId: shelf.id, spotId: spotIds[0]!, addedAt: sql`'2026-01-01 00:00:01+00'` },
        { collectionId: shelf.id, spotId: spotIds[1]!, addedAt: sql`'2026-01-01 00:00:03.123+00'` },
        ...spotIds.slice(2).map((spotId) => ({ collectionId: shelf.id, spotId, addedAt: sql`'2026-01-01 00:00:03.123456+00'` })),
      ]);
      const newestFirst = spotIds.toReversed();

      const page = await read(CollectionPageSchema, `/v1/collections/${shelf.id}`, { headers: stranger.bearer });
      expect(page.spots.map((row) => row.id)).toEqual(newestFirst);
      expect(page.collection.spotIds).toEqual(newestFirst);
      expect(page.nextCursor).toBeNull();

      const seen: string[] = [];
      const cursors: (string | null)[] = [];
      for (let cursor: string | null | undefined; cursor !== null; ) {
        const query = cursor === undefined ? "limit=2" : `limit=2&cursor=${cursor}`;
        const next = await read(CollectionSpotsPageSchema, `/v1/collections/${shelf.id}/spots?${query}`, { headers: stranger.bearer });
        seen.push(...next.items.map((row) => row.id));
        cursor = next.nextCursor;
        cursors.push(cursor);
      }
      expect(seen).toEqual(newestFirst);
      expect(cursors.map((cursor) => cursor === null)).toEqual([false, false, true]);

      const bad = await call(`/v1/collections/${shelf.id}/spots?cursor=not-a-cursor`, { headers: stranger.bearer });
      expect([bad.status, bad.body.error?.code]).toEqual([422, "validation_failed"]);

      await read(CollectionSchema, `/v1/collections/${shelf.id}`, json(owner, "PUT", { name: "Paged", visibility: "private" }));
      expect((await call(`/v1/collections/${shelf.id}/spots`, { headers: stranger.bearer })).status).toBe(404);
      expect((await read(CollectionSpotsPageSchema, `/v1/collections/${shelf.id}/spots`, { headers: owner.bearer })).items).toHaveLength(5);
    } finally {
      await db.delete(spot).where(inArray(spot.id, spotIds));
    }
  });

  test("a private spot is published at once into its collection, never reviewed, never public", async () => {
    const shelf = await saveCollection(owner, "private");
    const made = await privateSpot(owner, shelf.id);
    expect([made.status, made.collectionId]).toEqual(["approved", shelf.id]);
    const spotId = made.spotId!;

    const [row] = await db.select({ visibility: spot.visibility, status: spot.status }).from(spot).where(eq(spot.id, spotId));
    expect(row).toEqual({ visibility: "private", status: "published" });
    expect((await snapshot(owner)).privateSpots.map((item) => item.id)).toContain(spotId);
    expect((await details(owner, [spotId])).spots.map((detail) => [detail.id, detail.visibility])).toEqual([[spotId, "private"]]);

    expect(await syncedIds(stranger)).not.toContain(spotId);
    expect(await syncedIds(owner)).not.toContain(spotId);
    expect((await details(stranger, [spotId])).missing).toEqual([spotId]);
    expect((await snapshot(stranger)).privateSpots.map((item) => item.id)).not.toContain(spotId);
    expect((await call(`/v1/spots/${spotId}/vote`, json(stranger, "PUT", { value: 1 }))).status).toBe(404);
    expect((await call(`/v1/spots/${spotId}/card`)).status).toBe(404);
  });

  test("a private spot only goes into one of your private collections", async () => {
    const open = await saveCollection(owner, "public");
    const theirs = await saveCollection(friend, "private");
    for (const collectionId of [open.id, theirs.id]) {
      const submissionId = crypto.randomUUID();
      const { status } = await call(
        `/v1/submissions/${submissionId}`,
        json(owner, "PUT", {
          kind: "new_spot",
          title: "Nope",
          spotKind: "diy",
          latitude: 51.52,
          longitude: -0.1,
          collectionId,
          photos: [{ photoId, thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI", credit: { takenBy: "submitter" } }],
        }),
      );
      expect(status).toBe(422);
    }
  });

  test("an invite by username (in any case) waits for them to accept, and taking access away takes the spot off", async () => {
    const shelf = await saveCollection(owner, "private");
    const spotId = (await privateSpot(owner, shelf.id)).spotId!;
    expect((await details(friend, [spotId])).missing).toEqual([spotId]);

    const access = await read(CollectionAccessSchema, `/v1/collections/${shelf.id}/access`, json(owner, "POST", { username: `@Friend_${tag.toUpperCase()}` }));
    expect(access.members).toEqual([]);
    expect(access.invites.map((item) => [item.user?.id, item.email, item.role])).toEqual([[friend.userId, null, "viewer"]]);
    const invited = await snapshot(friend);
    expect(invited.collections.map((item) => item.id)).not.toContain(shelf.id);
    expect(invited.invitations.map((item) => [item.collectionId, item.role, item.invitedBy?.id])).toEqual([[shelf.id, "viewer", owner.userId]]);
    expect(invited.privateSpots.map((item) => item.id)).not.toContain(spotId);

    const joined = await read(CollectionSchema, `/v1/collections/${shelf.id}/invitation/accept`, json(friend, "POST"));
    expect(joined.role).toBe("viewer");
    expect((await read(CollectionSchema, `/v1/collections/${shelf.id}/invitation/accept`, json(friend, "POST"))).role).toBe("viewer");
    const shared = await snapshot(friend);
    expect(shared.invitations).toEqual([]);
    expect(shared.collections.find((item) => item.id === shelf.id)?.role).toBe("viewer");
    expect(shared.privateSpots.map((item) => item.id)).toContain(spotId);
    expect((await details(friend, [spotId])).spots.map((detail) => detail.id)).toEqual([spotId]);

    const theirs = await saveCollection(friend, "private");
    expect((await call(`/v1/collections/${theirs.id}/spots/${spotId}`, json(friend, "PUT"))).status).toBe(404);

    await read(z.object({ removed: z.literal(true) }), `/v1/collections/${shelf.id}/members/${friend.userId}`, json(owner, "DELETE"));
    const after = await snapshot(friend);
    expect(after.collections.map((item) => item.id)).not.toContain(shelf.id);
    expect(after.privateSpots.map((item) => item.id)).not.toContain(spotId);
    expect((await details(friend, [spotId])).missing).toEqual([spotId]);
  });

  test("an email invite answers the same either way and becomes that account's invitation, never naming it", async () => {
    const shelf = await saveCollection(owner, "private");
    const [registered] = await db.select({ email: user.email }).from(user).where(eq(user.id, invitee.userId));
    const forRegistered = await read(CollectionAccessSchema, `/v1/collections/${shelf.id}/access`, json(owner, "POST", { email: registered!.email.toUpperCase(), role: "editor" }));
    const forNobody = await read(CollectionAccessSchema, `/v1/collections/${shelf.id}/access`, json(owner, "POST", { email: `nobody-${tag}@example.com` }));
    expect(forRegistered.members).toEqual([]);
    expect(forNobody.members).toEqual([]);
    expect(forNobody.invites.map((item) => item.email).sort()).toEqual([registered!.email.toLowerCase(), `nobody-${tag}@example.com`].sort());

    const loaded = await snapshot(invitee);
    expect(loaded.collections.map((item) => item.id)).not.toContain(shelf.id);
    expect(loaded.invitations.map((item) => [item.collectionId, item.role])).toEqual([[shelf.id, "editor"]]);
    const waiting = await read(CollectionAccessSchema, `/v1/collections/${shelf.id}/access`, { headers: owner.bearer });
    expect(waiting.invites.map((item) => [item.email, item.user])).toContainEqual([registered!.email.toLowerCase(), null]);

    await read(CollectionSchema, `/v1/collections/${shelf.id}/invitation/accept`, json(invitee, "POST"));
    const access = await read(CollectionAccessSchema, `/v1/collections/${shelf.id}/access`, { headers: owner.bearer });
    expect(access.members.map((member) => [member.user.id, member.role])).toEqual([[invitee.userId, "editor"]]);
    expect(access.invites.map((item) => item.email)).toEqual([`nobody-${tag}@example.com`]);

    await read(z.object({ removed: z.literal(true) }), `/v1/collections/${shelf.id}/members/${invitee.userId}`, json(invitee, "DELETE"));
    expect((await snapshot(invitee)).collections.map((item) => item.id)).not.toContain(shelf.id);
  });

  test("a declined invitation is gone, and accepting one that isn't there is a 404", async () => {
    const shelf = await saveCollection(owner, "private");
    await read(CollectionAccessSchema, `/v1/collections/${shelf.id}/access`, json(owner, "POST", { username: `friend_${tag}` }));
    await read(z.object({ declined: z.literal(true) }), `/v1/collections/${shelf.id}/invitation/decline`, json(friend, "POST"));
    expect((await snapshot(friend)).invitations.map((item) => item.collectionId)).not.toContain(shelf.id);
    expect((await call(`/v1/collections/${shelf.id}/invitation/accept`, json(friend, "POST"))).status).toBe(404);
    expect((await read(CollectionAccessSchema, `/v1/collections/${shelf.id}/access`, { headers: owner.bearer })).invites).toEqual([]);
  });

  test("an email invite that's declined, or reaches someone already in, stays pending to the inviter like an unused address", async () => {
    const shelf = await saveCollection(owner, "private");
    const emailOf = async (rider: Rider) => (await db.select({ email: user.email }).from(user).where(eq(user.id, rider.userId)))[0]!.email.toLowerCase();
    const access = () => read(CollectionAccessSchema, `/v1/collections/${shelf.id}/access`, { headers: owner.bearer });
    await read(CollectionAccessSchema, `/v1/collections/${shelf.id}/access`, json(owner, "POST", { username: `friend_${tag}` }));
    await read(CollectionSchema, `/v1/collections/${shelf.id}/invitation/accept`, json(friend, "POST"));
    const emails = [await emailOf(invitee), await emailOf(friend), `nobody-${tag}@example.com`];
    for (const email of emails) await read(CollectionAccessSchema, `/v1/collections/${shelf.id}/access`, json(owner, "POST", { email }));

    expect((await snapshot(friend)).invitations.map((item) => item.collectionId)).not.toContain(shelf.id);
    expect((await snapshot(invitee)).invitations.map((item) => item.collectionId)).toContain(shelf.id);
    await read(z.object({ declined: z.literal(true) }), `/v1/collections/${shelf.id}/invitation/decline`, json(invitee, "POST"));
    expect((await snapshot(invitee)).invitations.map((item) => item.collectionId)).not.toContain(shelf.id);

    const after = await access();
    expect(after.invites.map((item) => [item.email, item.user]).sort()).toEqual(emails.map((email) => [email, null]).sort());
    expect(after.members.map((member) => member.user.id)).toEqual([friend.userId]);
    await read(z.object({ requested: z.literal(true) }), `/v1/collections/${shelf.id}/requests`, json(invitee, "POST"));
    expect((await access()).requests.map((request) => request.user.id)).toEqual([invitee.userId]);
  });

  test("an invitation from someone you blocked isn't shown", async () => {
    const shelf = await saveCollection(owner, "private");
    await read(CollectionAccessSchema, `/v1/collections/${shelf.id}/access`, json(owner, "POST", { username: `friend_${tag}` }));
    await db.insert(userBlock).values({ blockerId: friend.userId, blockedId: owner.userId });
    try {
      expect((await snapshot(friend)).invitations.map((item) => item.collectionId)).not.toContain(shelf.id);
    } finally {
      await db.delete(userBlock).where(eq(userBlock.blockerId, friend.userId));
    }
  });

  test("a private spot is never reviewed: an admin's undo takes it down without queueing it, and it never counts in stats", async () => {
    const admin = await createRider(db, "Admin");
    await db.update(user).set({ role: "admin" }).where(eq(user.id, admin.userId));
    try {
      const statsOf = async () => (await read(PublicProfileSchema, `/v1/users/${owner.userId}`, { headers: friend.bearer })).stats;
      const before = await statsOf();
      const shelf = await saveCollection(owner, "private");
      const takenDown = await privateSpot(owner, shelf.id);
      await privateSpot(owner, shelf.id);

      expect((await call(`/v1/review/${takenDown.id}/undo`, json(owner, "POST", {}))).status).toBe(403);
      const undone = await read(SubmissionSchema, `/v1/review/${takenDown.id}/undo`, json(admin, "POST", {}));
      expect(undone.status).toBe("approved");
      expect((await db.select({ status: spot.status }).from(spot).where(eq(spot.id, takenDown.spotId!)))[0]?.status).toBe("removed");
      const queue = await read(ReviewQueueSchema, "/v1/review/queue?limit=50", { headers: admin.bearer });
      expect(queue.items.map((item) => item.id)).not.toContain(takenDown.id);
      expect((await call(`/v1/review/${takenDown.id}/approve`, json(admin, "POST", { seenUpdatedAt: undone.updatedAt }))).status).toBe(403);

      // Deleting the collection clears collection_id; the spots stay private everywhere.
      await read(z.object({ deleted: z.literal(true) }), `/v1/collections/${shelf.id}`, json(owner, "DELETE"));
      expect(await statsOf()).toEqual(before);
      expect((await call(`/v1/review/${takenDown.id}/approve`, json(admin, "POST", { seenUpdatedAt: undone.updatedAt }))).status).toBe(403);
      expect(await reviewResultNotice(db, { ...undone, collectionId: null })).toBeUndefined();
    } finally {
      await db.delete(user).where(eq(user.id, admin.userId));
    }
  });

  test("viewers see, editors change its spots and name, admins also its people, visibility and existence", async () => {
    const shelf = await saveCollection(owner, "private", "Crew spots");
    const add = async (rider: Rider, role: "viewer" | "editor" | "admin") => {
      await db.insert(schema.collectionMember).values({ collectionId: shelf.id, userId: rider.userId, role });
    };
    await add(friend, "viewer");
    await add(stranger, "editor");
    await add(invitee, "admin");

    const people = await read(CollectionAccessSchema, `/v1/collections/${shelf.id}/access`, { headers: friend.bearer });
    expect([people.owner.id, people.members.length, people.invites, people.requests]).toEqual([owner.userId, 3, [], []]);
    expect((await call(`/v1/collections/${shelf.id}/spots/${publicSpot}`, json(friend, "PUT"))).status).toBe(403);
    expect((await call(`/v1/collections/${shelf.id}`, json(friend, "PUT", { name: "Mine", visibility: "private" }))).status).toBe(403);

    expect((await read(CollectionSchema, `/v1/collections/${shelf.id}/spots/${publicSpot}`, json(stranger, "PUT"))).spotIds).toEqual([publicSpot]);
    expect((await read(CollectionSchema, `/v1/collections/${shelf.id}`, json(stranger, "PUT", { name: "Crew lines", visibility: "private" }))).role).toBe("editor");
    const opened = await call(`/v1/collections/${shelf.id}`, json(stranger, "PUT", { name: "Crew lines", visibility: "public" }));
    expect([opened.status, opened.body.error?.code]).toEqual([403, "forbidden"]);
    expect((await call(`/v1/collections/${shelf.id}/access`, json(stranger, "POST", { username: `friend_${tag}` }))).status).toBe(403);
    expect((await call(`/v1/collections/${shelf.id}`, json(stranger, "DELETE"))).status).toBe(403);
    const editorsPhoto = crypto.randomUUID();
    await db.insert(photoUpload).values({ id: editorsPhoto, uploadedBy: stranger.userId, r2Key: `photos/${editorsPhoto}.jpg`, bytes: 1000, width: 800, height: 600 });
    const made = await privateSpot(stranger, shelf.id, editorsPhoto);
    expect(made.status).toBe("approved");

    const promoted = await read(CollectionAccessSchema, `/v1/collections/${shelf.id}/members/${friend.userId}`, json(invitee, "PUT", { role: "editor" }));
    expect(promoted.members.find((member) => member.user.id === friend.userId)?.role).toBe("editor");
    expect((await read(CollectionSchema, `/v1/collections/${shelf.id}`, json(invitee, "PUT", { name: "Crew lines", visibility: "public" }))).visibility).toBe("public");
    await read(z.object({ removed: z.literal(true) }), `/v1/collections/${shelf.id}/members/${stranger.userId}`, json(invitee, "DELETE"));
    await read(z.object({ deleted: z.literal(true) }), `/v1/collections/${shelf.id}`, json(invitee, "DELETE"));
    expect((await call(`/v1/collections/${shelf.id}`, { headers: owner.bearer })).status).toBe(404);
    await db.delete(submission).where(eq(submission.submittedBy, stranger.userId));
    await db.delete(spot).where(eq(spot.id, made.spotId!));
    await db.delete(photoUpload).where(eq(photoUpload.id, editorsPhoto));
  });

  test("asking to join answers the same for any link; the owner or an admin lets you in, once", async () => {
    const shelf = await saveCollection(owner, "private", "Ask first");
    const ask = (as: Rider, id = shelf.id) => read(z.object({ requested: z.literal(true) }), `/v1/collections/${id}/requests`, json(as, "POST"));
    await ask(stranger);
    await ask(stranger);
    await ask(stranger, crypto.randomUUID());
    expect((await snapshot(stranger)).requestedIds).toEqual([shelf.id]);

    const waiting = await read(CollectionAccessSchema, `/v1/collections/${shelf.id}/access`, { headers: owner.bearer });
    expect(waiting.requests.map((request) => request.user.id)).toEqual([stranger.userId]);
    expect((await call(`/v1/collections/${shelf.id}/requests/${stranger.userId}/approve`, json(friend, "POST", {}))).status).toBe(404);

    const approved = await read(CollectionAccessSchema, `/v1/collections/${shelf.id}/requests/${stranger.userId}/approve`, json(owner, "POST", { role: "editor" }));
    expect([approved.requests, approved.members.map((member) => [member.user.id, member.role])]).toEqual([[], [[stranger.userId, "editor"]]]);
    const after = await snapshot(stranger);
    expect([after.requestedIds, after.collections.find((item) => item.id === shelf.id)?.role]).toEqual([[], "editor"]);
    expect((await call(`/v1/collections/${shelf.id}/requests/${stranger.userId}/approve`, json(owner, "POST", {}))).status).toBe(404);

    await ask(friend);
    const declined = await read(CollectionAccessSchema, `/v1/collections/${shelf.id}/requests/${friend.userId}`, json(owner, "DELETE"));
    expect(declined.requests).toEqual([]);
    expect((await snapshot(friend)).requestedIds).not.toContain(shelf.id);

    await ask(friend);
    const invited = await read(CollectionAccessSchema, `/v1/collections/${shelf.id}/access`, json(owner, "POST", { username: `friend_${tag}` }));
    expect([invited.invites, invited.requests, invited.members.some((member) => member.user.id === friend.userId)]).toEqual([[], [], true]);
  });

  test("someone outside a collection can't change it or see who's in it; a private one is a 404 to them", async () => {
    const shelf = await saveCollection(owner, "private");
    expect((await call(`/v1/collections/${shelf.id}`, json(stranger, "PUT", { name: "Mine now", visibility: "private" }))).status).toBe(404);
    expect((await call(`/v1/collections/${shelf.id}`, { headers: stranger.bearer })).status).toBe(404);
    expect((await call(`/v1/collections/${shelf.id}/access`, { headers: stranger.bearer })).status).toBe(404);
    expect((await call(`/v1/collections/${shelf.id}/spots/${publicSpot}`, json(stranger, "PUT"))).status).toBe(404);
    expect((await call(`/v1/collections/${shelf.id}/access`, json(stranger, "POST", { username: `friend_${tag}` }))).status).toBe(404);
    expect((await call(`/v1/collections/${shelf.id}/access`, json(owner, "POST", { username: `ghost_${tag}` }))).status).toBe(404);
    expect((await call(`/v1/collections/${shelf.id}`, json(stranger, "DELETE"))).status).toBe(404);
    expect((await call(`/v1/collections/${crypto.randomUUID()}`, json(stranger, "DELETE"))).status).toBe(404);

    const open = await saveCollection(owner, "public");
    expect((await call(`/v1/collections/${open.id}`, json(stranger, "PUT", { name: "Mine now", visibility: "public" }))).status).toBe(403);
    expect((await call(`/v1/collections/${open.id}/access`, { headers: stranger.bearer })).status).toBe(403);
    expect((await call(`/v1/collections/${open.id}/spots/${publicSpot}`, json(stranger, "PUT"))).status).toBe(403);
    expect((await call(`/v1/collections/${open.id}`, json(stranger, "DELETE"))).status).toBe(403);
  });

  test("each kind of write has its own budget per account", async () => {
    const writes = { WRITE_LIMITER: countingLimiter(2) };
    const vote = (as: Rider) => call(`/v1/spots/${publicSpot}/vote`, json(as, "PUT", { value: 1 }), writes);
    expect([(await vote(owner)).status, (await vote(owner)).status]).toEqual([200, 200]);
    const over = await vote(owner);
    expect([over.status, over.body.error?.code, over.headers.get("Retry-After")]).toEqual([429, "rate_limited", "60"]);

    const id = crypto.randomUUID();
    created.push(id);
    expect((await call(`/v1/collections/${id}`, json(owner, "PUT", { name: "Budget", visibility: "private" }), writes)).status).toBe(200);
    expect((await vote(friend)).status).toBe(200);
  });

  test("sharing a collection counts on the tight outreach budget, apart from changing it", async () => {
    const shelf = await saveCollection(owner, "private");
    const outreach = { OUTREACH_LIMITER: countingLimiter(1) };
    const share = (email: string) => call(`/v1/collections/${shelf.id}/access`, json(owner, "POST", { email }), outreach);
    expect((await share(`first-${tag}@example.com`)).status).toBe(200);
    const over = await share(`second-${tag}@example.com`);
    expect([over.status, over.body.error?.code]).toEqual([429, "rate_limited"]);
    expect((await call(`/v1/collections/${shelf.id}`, json(owner, "PUT", { name: "Renamed", visibility: "private" }), outreach)).status).toBe(200);
  });

  test("a public collection opens by its link and lists on the profile, except for someone the owner blocked", async () => {
    const open = await saveCollection(owner, "public", "London lines");
    await read(CollectionSchema, `/v1/collections/${open.id}/spots/${publicSpot}`, json(owner, "PUT"));
    const again = await read(CollectionSchema, `/v1/collections/${open.id}/spots/${publicSpot}`, json(owner, "PUT"));
    expect(again.spotIds).toEqual([publicSpot]);

    const page = await read(CollectionPageSchema, `/v1/collections/${open.id}`, { headers: stranger.bearer });
    expect([page.collection.role, page.spots.map((item) => item.id)]).toEqual(["guest", [publicSpot]]);
    const listed = await read(z.object({ collections: z.array(CollectionSchema) }), `/v1/users/${owner.userId}/collections`, { headers: stranger.bearer });
    expect(listed.collections.map((item) => item.id)).toContain(open.id);
    expect((await snapshot(stranger)).collections.map((item) => item.id)).not.toContain(open.id);

    await db.insert(userBlock).values({ blockerId: owner.userId, blockedId: stranger.userId });
    expect((await call(`/v1/collections/${open.id}`, { headers: stranger.bearer })).status).toBe(404);
    expect((await call(`/v1/users/${owner.userId}/collections`, { headers: stranger.bearer })).status).toBe(404);
    await db.delete(userBlock).where(eq(userBlock.blockerId, owner.userId));
  });

  test("a private collection made public shows its private spots to anyone with the link", async () => {
    const shelf = await saveCollection(owner, "private", "Secret then not");
    const spotId = (await privateSpot(owner, shelf.id)).spotId!;
    expect((await details(stranger, [spotId])).missing).toEqual([spotId]);
    await read(CollectionSchema, `/v1/collections/${shelf.id}`, json(owner, "PUT", { name: "Secret then not", visibility: "public" }));
    expect((await details(stranger, [spotId])).spots.map((detail) => detail.id)).toEqual([spotId]);
    expect(await syncedIds(stranger)).not.toContain(spotId);

    await read(z.object({ deleted: z.literal(true) }), `/v1/collections/${shelf.id}`, json(owner, "DELETE"));
    expect((await details(stranger, [spotId])).missing).toEqual([spotId]);
    expect((await snapshot(owner)).privateSpots.map((item) => item.id)).toContain(spotId);
    expect(await db.$count(spot, sql`${spot.id} = ${spotId}`)).toBe(1);
  });

  test("every account has one Favorites: made with the first snapshot, starred into, never renamed or deleted", async () => {
    const first = await snapshot(friend);
    const favorites = first.collections.filter((item) => item.kind === "favorites");
    expect(favorites.map((item) => [item.name, item.role, item.appearance.color, item.appearance.pattern])).toEqual([["Favorites", "owner", "amber", "star"]]);
    expect(first.collections[0]?.kind).toBe("favorites");
    const id = favorites[0]!.id;
    created.push(id);
    expect((await snapshot(friend)).collections.filter((item) => item.kind === "favorites").map((item) => item.id)).toEqual([id]);

    expect((await read(CollectionSchema, `/v1/me/favorites/${publicSpot}`, json(friend, "PUT"))).spotIds).toEqual([publicSpot]);
    expect((await read(CollectionSchema, `/v1/me/favorites/${publicSpot}`, json(friend, "PUT"))).spotIds).toEqual([publicSpot]);
    expect((await read(CollectionSchema, `/v1/me/favorites/${publicSpot}`, json(friend, "DELETE"))).spotIds).toEqual([]);

    const renamed = await call(`/v1/collections/${id}`, json(friend, "PUT", { name: "Faves", visibility: "private" }));
    expect([renamed.status, renamed.body.error?.code]).toEqual([422, "validation_failed"]);
    const deleted = await call(`/v1/collections/${id}`, json(friend, "DELETE"));
    expect([deleted.status, deleted.body.error?.code]).toEqual([403, "forbidden"]);
  });

  test("a collection's look: a colour from its id until chosen, a pattern, and only your own photo", async () => {
    const shelf = await saveCollection(owner, "private", "Looks");
    expect(shelf.appearance).toEqual({ color: shelf.appearance.color });
    const again = await read(CollectionSchema, `/v1/collections/${shelf.id}`, json(owner, "PUT", { name: "Looks", visibility: "private" }));
    expect(again.appearance.color).toBe(shelf.appearance.color);

    const styled = await read(
      CollectionSchema,
      `/v1/collections/${shelf.id}`,
      json(owner, "PUT", { name: "Looks", visibility: "private", appearance: { color: "violet", pattern: "flame", photo: { photoId, thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI" } } }),
    );
    expect(styled.appearance).toEqual({ color: "violet", pattern: "flame", photo: { id: photoId, key: `photos/${photoId}.jpg`, thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI" } });
    const renamedOnly = await read(CollectionSchema, `/v1/collections/${shelf.id}`, json(owner, "PUT", { name: "Looks 2", visibility: "private" }));
    expect(renamedOnly.appearance.pattern).toBe("flame");
    const plain = await read(CollectionSchema, `/v1/collections/${shelf.id}`, json(owner, "PUT", { name: "Looks 2", visibility: "private", appearance: {} }));
    expect(plain.appearance).toEqual({ color: shelf.appearance.color });

    const unknownPhoto = crypto.randomUUID();
    const notTheirs = await call(
      `/v1/collections/${shelf.id}`,
      json(owner, "PUT", { name: "Looks 2", visibility: "private", appearance: { photo: { photoId: unknownPhoto, thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI" } } }),
    );
    expect(notTheirs.status).toBe(422);
    expect(notTheirs.body.error).toMatchObject({ code: "validation_failed", details: { missingPhotos: [unknownPhoto] } });
  });
});
