import type { Database } from "@openskatemap/db";
import {
  collection,
  collectionInvite,
  collectionMember,
  collectionRequest,
  collectionSpot,
  photoUpload,
  profile,
  spot,
  spotPhoto,
  user,
} from "@openskatemap/db/schema";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, not, or, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { COLLECTION_COLORS, COLLECTION_ROLES } from "@openskatemap/db/schema";
import { z } from "@hono/zod-openapi";
import type {
  Collection,
  CollectionAccess,
  CollectionAppearanceDraft,
  CollectionDraft,
  CollectionInviteDraft,
  CollectionMemberRole,
  CollectionPage,
  CollectionSpotsPage,
  CollectionsSnapshot,
} from "../lib/collection-schemas.ts";
import { after, keysetPage } from "../lib/paging.ts";

type CollectionColor = (typeof COLLECTION_COLORS)[number];
import type { AppError } from "../lib/errors.ts";
import { type Attempt, err, ok, type Result, safeTry } from "../lib/result.ts";
import type { SpotIndexRow } from "../lib/spot-schemas.ts";
import { blocks, hasBlocked } from "./people.ts";
import { requireUploads } from "./photos.ts";
import { coverJoin, indexColumns, toIndexRow } from "./spots.ts";
import { inTransaction } from "../lib/transaction";

const MEMBER_LIMIT = 200;
const INVITE_LIMIT = 100;

const notFound: AppError = { code: "not_found", message: "No such collection" };

export async function emailHash(email: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email.trim().toLowerCase()));
  return new Uint8Array(digest).toHex();
}

const isMember = (viewerId: string) =>
  sql<boolean>`exists (select 1 from ${collectionMember} where ${collectionMember.collectionId} = ${collection.id} and ${collectionMember.userId} = ${viewerId})`;

const memberRole = (viewerId: string) =>
  sql<CollectionMemberRole | null>`(select ${collectionMember.role} from ${collectionMember} where ${collectionMember.collectionId} = ${collection.id} and ${collectionMember.userId} = ${viewerId})`;

const canSeeCollection = (viewerId: string) =>
  or(
    eq(collection.ownerId, viewerId),
    isMember(viewerId),
    and(
      eq(collection.visibility, "public"),
      not(hasBlocked(collection.ownerId, viewerId)),
    ),
  );

export const canSeeSpot = (viewerId: string): SQL =>
  sql`(${spot.visibility} = 'public' or ${spot.createdBy} = ${viewerId} or exists (
    select 1 from ${collectionSpot} join ${collection} on ${collection.id} = ${collectionSpot.collectionId}
    where ${collectionSpot.spotId} = ${spot.id} and (${canSeeCollection(viewerId)})
  ))`;

// Lowest first: `atLeast` compares positions.
const RANKS = [...COLLECTION_ROLES, "owner"] as const;
type Rank = (typeof RANKS)[number];
const atLeast = (role: Rank | undefined, needed: Rank) => role !== undefined && RANKS.indexOf(role) >= RANKS.indexOf(needed);

const refusals: Record<Exclude<Rank, "viewer">, AppError> = {
  editor: { code: "forbidden", message: "Only the collection's editors can change it" },
  admin: { code: "forbidden", message: "Only the collection's owner and admins can do that" },
  owner: { code: "forbidden", message: "Only the collection's owner can do that" },
};
const notInIt: AppError = { code: "forbidden", message: "Only the collection's people see who's in it" };

interface Standing {
  readonly ownerId: string;
  readonly kind: "custom" | "favorites";
  readonly name: string;
  readonly visibility: "private" | "public";
  readonly role: Rank | undefined;
}

/** `not_found` for a collection the actor can't see, so a private collection's id never confirms it exists. */
async function standing(db: Database, actorId: string, id: string, needed: Rank): Promise<Result<Standing, AppError>> {
  const [row] = await db
    .select({
      ownerId: collection.ownerId,
      kind: collection.kind,
      name: collection.name,
      visibility: collection.visibility,
      memberRole: memberRole(actorId),
      visible: sql<boolean>`(${canSeeCollection(actorId)})`,
    })
    .from(collection)
    .where(eq(collection.id, id));
  if (!row?.visible) return err(notFound);
  const role = row.ownerId === actorId ? "owner" : (row.memberRole ?? undefined);
  if (!atLeast(role, needed)) return err(needed === "viewer" ? notInIt : refusals[needed]);
  return ok({ ownerId: row.ownerId, kind: row.kind, name: row.name, visibility: row.visibility, role });
}

export function automaticColor(id: string): CollectionColor {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return COLLECTION_COLORS[hash % COLLECTION_COLORS.length] ?? "blue";
}

const photos = alias(photoUpload, "collection_photo");

const collectionColumns = (viewerId: string) => ({
  id: collection.id,
  name: collection.name,
  description: collection.description,
  visibility: collection.visibility,
  kind: collection.kind,
  color: collection.color,
  pattern: collection.pattern,
  photoId: collection.photoId,
  photoKey: photos.r2Key,
  photoThumbhash: collection.photoThumbhash,
  ownerId: collection.ownerId,
  ownerName: user.name,
  ownerUsername: profile.username,
  memberRole: memberRole(viewerId),
  createdAt: collection.createdAt,
  updatedAt: collection.updatedAt,
});

async function loadCollections(db: Database, viewerId: string, where: SQL | undefined, order: SQL[] = [desc(collection.createdAt)]): Promise<Collection[]> {
  const rows = await db
    .select(collectionColumns(viewerId))
    .from(collection)
    .innerJoin(user, eq(user.id, collection.ownerId))
    .leftJoin(profile, eq(profile.userId, collection.ownerId))
    .leftJoin(photos, eq(photos.id, collection.photoId))
    .where(where)
    .orderBy(...order);
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const spots = await db
    .select({ collectionId: collectionSpot.collectionId, spotId: spot.id, cover: indexColumns.cover })
    .from(collectionSpot)
    .innerJoin(spot, and(eq(spot.id, collectionSpot.spotId), eq(spot.status, "published")))
    .leftJoin(spotPhoto, coverJoin)
    .where(inArray(collectionSpot.collectionId, ids))
    .orderBy(desc(collectionSpot.addedAt), desc(collectionSpot.spotId));
  const members = await db
    .select({ collectionId: collectionMember.collectionId, count: count() })
    .from(collectionMember)
    .where(inArray(collectionMember.collectionId, ids))
    .groupBy(collectionMember.collectionId);
  const spotsByCollection = Map.groupBy(spots, (row) => row.collectionId);
  const memberCounts = new Map(members.map((row) => [row.collectionId, row.count]));
  return rows.map(({ ownerId, ownerName, ownerUsername, memberRole: member, color, pattern, photoId, photoKey, photoThumbhash, createdAt, updatedAt, ...row }) => {
    const inside = spotsByCollection.get(row.id) ?? [];
    return {
      ...row,
      appearance: {
        color: color ?? automaticColor(row.id),
        ...(pattern === null ? {} : { pattern }),
        ...(photoId === null || photoKey === null || photoThumbhash === null ? {} : { photo: { id: photoId, key: photoKey, thumbhash: photoThumbhash } }),
      },
      role: ownerId === viewerId ? "owner" : (member ?? "guest"),
      owner: { id: ownerId, name: ownerName, username: ownerUsername },
      spotIds: inside.map((entry) => entry.spotId),
      memberCount: memberCounts.get(row.id) ?? 0,
      cover: inside[0]?.cover ?? null,
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
    };
  });
}

async function loadCollection(db: Database, viewerId: string, id: string): Promise<Collection | undefined> {
  const [found] = await loadCollections(db, viewerId, and(eq(collection.id, id), canSeeCollection(viewerId)));
  return found;
}

const touch = (db: Database, id: string) => db.update(collection).set({ updatedAt: new Date() }).where(eq(collection.id, id));

async function readBack(db: Database, actorId: string, id: string): Promise<Result<Collection, AppError>> {
  const found = await loadCollection(db, actorId, id);
  return found ? ok(found) : err({ code: "internal_error", message: "The collection was saved but could not be read back" });
}

const unmatchedInvites = (hash: string) => and(eq(collectionInvite.emailHash, hash), isNull(collectionInvite.userId), isNull(collectionInvite.declinedAt));

// Invites reaching someone already in or invited are marked declined: pending to the inviter, like unused addresses.
async function resolveInvites(db: Database, viewerId: string, hash: string) {
  const waiting = unmatchedInvites(hash);
  await db.transaction(async (tx) => {
    await tx.update(collectionInvite).set({ declinedAt: new Date() }).where(
      and(
        waiting,
        sql`(exists (select 1 from ${collection} where ${collection.id} = ${collectionInvite.collectionId} and ${collection.ownerId} = ${viewerId})
          or exists (select 1 from ${collectionMember} where ${collectionMember.collectionId} = ${collectionInvite.collectionId} and ${collectionMember.userId} = ${viewerId})
          or exists (select 1 from ${collectionInvite} as mine where mine.collection_id = ${collectionInvite.collectionId} and mine.user_id = ${viewerId}))`,
      ),
    );
    await tx.update(collectionInvite).set({ userId: viewerId }).where(waiting);
  });
}

const owners = alias(user, "owner");
const ownerProfiles = alias(profile, "owner_profile");
const inviters = alias(user, "inviter");
const inviterProfiles = alias(profile, "inviter_profile");

async function invitationsFor(db: Database, viewerId: string): Promise<CollectionsSnapshot["invitations"]> {
  const rows = await db
    .select({
      collectionId: collection.id,
      name: collection.name,
      owner: { id: owners.id, name: owners.name, username: ownerProfiles.username },
      role: collectionInvite.role,
      inviterId: inviters.id,
      inviterName: inviters.name,
      inviterUsername: inviterProfiles.username,
      createdAt: collectionInvite.createdAt,
    })
    .from(collectionInvite)
    .innerJoin(collection, eq(collection.id, collectionInvite.collectionId))
    .innerJoin(owners, eq(owners.id, collection.ownerId))
    .leftJoin(ownerProfiles, eq(ownerProfiles.userId, owners.id))
    .leftJoin(inviters, eq(inviters.id, collectionInvite.invitedBy))
    .leftJoin(inviterProfiles, eq(inviterProfiles.userId, inviters.id))
    .where(
      and(
        eq(collectionInvite.userId, viewerId),
        not(hasBlocked(viewerId, collection.ownerId)),
        not(hasBlocked(viewerId, collectionInvite.invitedBy)),
      ),
    )
    .orderBy(desc(collectionInvite.createdAt));
  return rows.map(({ inviterId, inviterName, inviterUsername, createdAt, ...row }) => ({
    ...row,
    invitedBy: inviterId !== null && inviterName !== null ? { id: inviterId, name: inviterName, username: inviterUsername } : null,
    createdAt: createdAt.toISOString(),
  }));
}

export async function favoritesOf(db: Database, ownerId: string): Promise<string> {
  const find = async () => {
    const [row] = await db
      .select({ id: collection.id })
      .from(collection)
      .where(and(eq(collection.ownerId, ownerId), eq(collection.kind, "favorites")));
    return row?.id;
  };
  const existing = await find();
  if (existing) return existing;
  await db
    .insert(collection)
    .values({ id: sql`uuidv7()::text`, ownerId, name: "Favorites", kind: "favorites", color: "amber", pattern: "star" })
    .onConflictDoNothing();
  const made = await find();
  if (!made) throw new Error("Favorites could not be made");
  return made;
}

/** SQL: the ids of the collections `viewerId` owns or is in, read through the owner and member indexes. */
const collectionsOf = (viewerId: string) =>
  sql`(select ${collection.id} from ${collection} where ${collection.ownerId} = ${viewerId}
    union all select ${collectionMember.collectionId} from ${collectionMember} where ${collectionMember.userId} = ${viewerId})`;

export async function collectionsSnapshot(db: Database, viewer: { id: string; email: string }): Promise<CollectionsSnapshot> {
  const hash = await emailHash(viewer.email);
  const [pending] = await db
    .select({
      favorites: sql<boolean>`exists (select 1 from ${collection} where ${collection.ownerId} = ${user.id} and ${collection.kind} = 'favorites')`,
      invites: sql<boolean>`exists (select 1 from ${collectionInvite} where ${unmatchedInvites(hash)})`,
    })
    .from(user)
    .where(eq(user.id, viewer.id));
  if (!pending?.favorites) await favoritesOf(db, viewer.id);
  if (pending?.invites) await resolveInvites(db, viewer.id, hash);
  const mine = collectionsOf(viewer.id);
  const collections = await loadCollections(db, viewer.id, sql`${collection.id} in ${mine}`, [
    sql`case when ${collection.ownerId} = ${viewer.id} and ${collection.kind} = 'favorites' then 0 when ${collection.ownerId} = ${viewer.id} then 1 else 2 end`,
    desc(collection.createdAt),
  ]);
  const privateSpots = await db
    .select(indexColumns)
    .from(spot)
    .leftJoin(spotPhoto, coverJoin)
    .where(
      and(
        eq(spot.visibility, "private"),
        eq(spot.status, "published"),
        sql`${spot.id} in (
          select ${spot.id} from ${spot} where ${spot.createdBy} = ${viewer.id} and ${spot.visibility} = 'private'
          union all
          select ${collectionSpot.spotId} from ${collectionSpot} where ${collectionSpot.collectionId} in ${mine}
        )`,
      ),
    )
    .orderBy(asc(spot.version));
  const invitations = await invitationsFor(db, viewer.id);
  const requests = await db.select({ id: collectionRequest.collectionId }).from(collectionRequest).where(eq(collectionRequest.userId, viewer.id));
  return { collections, invitations, requestedIds: requests.map((row) => row.id), privateSpots: privateSpots.map(toIndexRow) };
}

export const COLLECTION_SPOTS_PAGE = { defaultLimit: 200, maxLimit: 500 } as const;

/** A collection's spots in `spotIds` order (newest added first), keyed by when each was added and its id. */
export const collectionSpotsKey = z.tuple([z.string(), z.string()]);

async function spotsPage(db: Database, id: string, cursor: z.infer<typeof collectionSpotsKey> | undefined, limit: number): Promise<CollectionSpotsPage> {
  const rows = await db
    // As text: a JS Date would cut the timestamp to milliseconds, and the next page would skip or repeat spots.
    .select({ ...indexColumns, addedAt: sql<string>`${collectionSpot.addedAt}::text` })
    .from(collectionSpot)
    .innerJoin(spot, and(eq(spot.id, collectionSpot.spotId), eq(spot.status, "published")))
    .leftJoin(spotPhoto, coverJoin)
    .where(and(eq(collectionSpot.collectionId, id), cursor === undefined ? undefined : after([collectionSpot.addedAt, collectionSpot.spotId], cursor, "desc")))
    .orderBy(desc(collectionSpot.addedAt), desc(collectionSpot.spotId))
    .limit(limit + 1);
  const page = keysetPage(rows, limit, (row) => [row.addedAt, row.id]);
  return { items: page.items.map(({ addedAt: _, ...row }) => toIndexRow(row) satisfies SpotIndexRow), nextCursor: page.nextCursor };
}

export async function collectionPage(db: Database, viewerId: string, id: string): Promise<Result<CollectionPage, AppError>> {
  const found = await loadCollection(db, viewerId, id);
  if (!found) return err(notFound);
  const first = await spotsPage(db, id, undefined, COLLECTION_SPOTS_PAGE.defaultLimit);
  return ok({ collection: found, spots: first.items, nextCursor: first.nextCursor });
}

export async function collectionSpots(
  db: Database,
  viewerId: string,
  id: string,
  { cursor, limit }: { cursor?: z.infer<typeof collectionSpotsKey> | undefined; limit: number },
): Promise<Result<CollectionSpotsPage, AppError>> {
  if ((await db.$count(collection, and(eq(collection.id, id), canSeeCollection(viewerId)))) === 0) return err(notFound);
  return ok(await spotsPage(db, id, cursor, limit));
}

export async function userCollections(db: Database, viewerId: string, userId: string): Promise<Result<Collection[], AppError>> {
  const [person] = await db.select({ id: user.id }).from(user).where(eq(user.id, userId));
  const blocked =
    viewerId !== userId && (await blocks(db, userId, viewerId));
  if (!person || blocked) return err({ code: "not_found", message: "No such person" });
  return ok(await loadCollections(db, viewerId, and(eq(collection.ownerId, userId), eq(collection.visibility, "public"))));
}

export async function saveCollection(db: Database, actorId: string, id: string, draft: CollectionDraft): Promise<Result<Collection, AppError>> {
  const { appearance, ...fields } = draft;
  const saved = await inTransaction(db, (tx) => safeTry(async function* (): Attempt<void, AppError> {
    await tx.insert(collection).values({ id, ownerId: actorId, ...fields }).onConflictDoNothing();
    // The row lock makes concurrent saves check and write in turn.
    await tx.select({ id: collection.id }).from(collection).where(eq(collection.id, id)).for("update");
    const current = yield* await standing(tx, actorId, id, "editor");
    if (current.visibility !== fields.visibility && !atLeast(current.role, "admin")) {
      return err({ code: "forbidden", message: "Only the collection's owner and admins change who can see it" });
    }
    if (current.kind === "favorites" && current.name !== fields.name) {
      return err({ code: "validation_failed", message: "Favorites keeps its name" });
    }
    const look = yield* appearance === undefined ? ok({}) : await lookOf(tx, actorId, appearance);
    await tx.update(collection).set({ ...fields, ...look, updatedAt: new Date() }).where(eq(collection.id, id));
    return ok(undefined);
  }));
  return saved.isErr() ? err(saved.error) : readBack(db, actorId, id);
}

// Only a photo the actor uploaded, as for an avatar.
async function lookOf(db: Database, actorId: string, look: CollectionAppearanceDraft) {
  const uploaded = await requireUploads(db, actorId, look.photo === undefined ? [] : [look.photo.photoId]);
  if (uploaded.isErr()) return err(uploaded.error);
  return ok({
    color: look.color ?? null,
    pattern: look.pattern ?? null,
    photoId: look.photo?.photoId ?? null,
    photoThumbhash: look.photo?.thumbhash ?? null,
  });
}

export async function deleteCollection(db: Database, actorId: string, id: string): Promise<Result<{ deleted: true }, AppError>> {
  const allowed = await standing(db, actorId, id, "admin");
  if (allowed.isErr()) return err(allowed.error);
  if (allowed.value.kind === "favorites") return err({ code: "forbidden", message: "Favorites can't be deleted" });
  await db.delete(collection).where(eq(collection.id, id));
  return ok({ deleted: true });
}

export async function addSpot(db: Database, actorId: string, id: string, spotId: string): Promise<Result<Collection, AppError>> {
  const allowed = await standing(db, actorId, id, "editor");
  if (allowed.isErr()) return err(allowed.error);
  // Someone else's private spot never travels into another collection.
  const addable = await db.$count(
    spot,
    and(eq(spot.id, spotId), eq(spot.status, "published"), or(eq(spot.visibility, "public"), eq(spot.createdBy, actorId))),
  );
  if (addable === 0) return err({ code: "not_found", message: "No such spot" });
  const added = await db.insert(collectionSpot).values({ collectionId: id, spotId, addedBy: actorId }).onConflictDoNothing().returning();
  if (added.length > 0) await touch(db, id);
  return readBack(db, actorId, id);
}

export async function removeSpot(db: Database, actorId: string, id: string, spotId: string): Promise<Result<Collection, AppError>> {
  const allowed = await standing(db, actorId, id, "editor");
  if (allowed.isErr()) return err(allowed.error);
  const removed = await db
    .delete(collectionSpot)
    .where(and(eq(collectionSpot.collectionId, id), eq(collectionSpot.spotId, spotId)))
    .returning();
  if (removed.length > 0) await touch(db, id);
  return readBack(db, actorId, id);
}

const personColumns = {
  id: user.id,
  name: user.name,
  username: profile.username,
  avatarKey: photoUpload.r2Key,
  avatarThumbhash: profile.avatarThumbhash,
};

const toPerson = ({ avatarKey, avatarThumbhash, ...person }: { id: string; name: string; username: string | null; avatarKey: string | null; avatarThumbhash: string | null }) => ({
  ...person,
  avatar: avatarKey && avatarThumbhash ? { key: avatarKey, thumbhash: avatarThumbhash } : null,
});

/** Anyone in it sees the people; only the owner and admins see invites and requests. */
export async function collectionAccess(db: Database, actorId: string, id: string): Promise<Result<CollectionAccess, AppError>> {
  const allowed = await standing(db, actorId, id, "viewer");
  if (allowed.isErr()) return err(allowed.error);
  const { ownerId, visibility, role } = allowed.value;
  const [owner] = await db
    .select(personColumns)
    .from(user)
    .leftJoin(profile, eq(profile.userId, user.id))
    .leftJoin(photoUpload, eq(photoUpload.id, profile.avatarPhotoId))
    .where(eq(user.id, ownerId));
  if (!owner) return err(notFound);
  const members = await db
    .select({ ...personColumns, role: collectionMember.role, addedAt: collectionMember.addedAt })
    .from(collectionMember)
    .innerJoin(user, eq(user.id, collectionMember.userId))
    .leftJoin(profile, eq(profile.userId, user.id))
    .leftJoin(photoUpload, eq(photoUpload.id, profile.avatarPhotoId))
    .where(eq(collectionMember.collectionId, id))
    .orderBy(desc(collectionMember.addedAt));
  const manages = atLeast(role, "admin");
  const invites = manages
    ? await db
        .select({ inviteId: collectionInvite.id, email: collectionInvite.email, inviteRole: collectionInvite.role, createdAt: collectionInvite.createdAt, ...personColumns })
        .from(collectionInvite)
        .leftJoin(user, eq(user.id, collectionInvite.userId))
        .leftJoin(profile, eq(profile.userId, user.id))
        .leftJoin(photoUpload, eq(photoUpload.id, profile.avatarPhotoId))
        .where(eq(collectionInvite.collectionId, id))
        .orderBy(desc(collectionInvite.createdAt))
    : [];
  const requests = manages
    ? await db
        .select({ ...personColumns, createdAt: collectionRequest.createdAt })
        .from(collectionRequest)
        .innerJoin(user, eq(user.id, collectionRequest.userId))
        .leftJoin(profile, eq(profile.userId, user.id))
        .leftJoin(photoUpload, eq(photoUpload.id, profile.avatarPhotoId))
        .where(eq(collectionRequest.collectionId, id))
        .orderBy(asc(collectionRequest.createdAt))
    : [];
  return ok({
    visibility,
    owner: toPerson(owner),
    members: members.map(({ role: memberRole, addedAt, ...person }) => ({ user: toPerson(person), role: memberRole, addedAt: addedAt.toISOString() })),
    // An email invite names the email only, even after its account is known: who it reached is that person's to tell.
    invites: invites.map(({ inviteId, email, inviteRole, createdAt, id: personId, name, ...person }) => ({
      id: inviteId,
      email,
      user: email === null && personId !== null && name !== null ? toPerson({ id: personId, name, ...person }) : null,
      role: inviteRole,
      createdAt: createdAt.toISOString(),
    })),
    requests: requests.map(({ createdAt, ...person }) => ({ user: toPerson(person), createdAt: createdAt.toISOString() })),
  });
}

/** What an invite changed; null when nothing did (a repeat, or someone already in). */
export type Invited =
  | { readonly kind: "invited"; readonly inviteId: string; readonly userId: string }
  | { readonly kind: "emailed"; readonly inviteId: string }
  | { readonly kind: "added"; readonly userId: string };

/** An email is always stored and answered as an invite, so inviting never reveals who is registered. */
export async function invite(
  db: Database,
  actor: { id: string; email: string },
  id: string,
  draft: CollectionInviteDraft,
): Promise<Result<{ access: CollectionAccess; invited: Invited | null }, AppError>> {
  const allowed = await standing(db, actor.id, id, "admin");
  if (allowed.isErr()) return err(allowed.error);
  const invited = await inTransaction(db, (tx) => addInvite(tx, actor, allowed.value.ownerId, id, draft));
  if (invited.isErr()) return err(invited.error);
  const access = await collectionAccess(db, actor.id, id);
  return access.map((value) => ({ access: value, invited: invited.value }));
}

// Locks the collection's row first, so two invites at once can't both pass the caps.
async function addInvite(
  db: Database,
  actor: { id: string; email: string },
  ownerId: string,
  id: string,
  draft: CollectionInviteDraft,
): Promise<Result<Invited | null, AppError>> {
  await db.select({ id: collection.id }).from(collection).where(eq(collection.id, id)).for("update");
  if ((await db.$count(collectionInvite, eq(collectionInvite.collectionId, id))) >= INVITE_LIMIT) {
    return err({ code: "validation_failed", message: `A collection can wait on ${INVITE_LIMIT} invites` });
  }
  if (draft.email !== undefined) {
    if (draft.email === actor.email.trim().toLowerCase()) return err({ code: "validation_failed", message: "That's you" });
    const [emailed] = await db
      .insert(collectionInvite)
      .values({ id: sql`uuidv7()::text`, collectionId: id, emailHash: await emailHash(draft.email), email: draft.email, role: draft.role, invitedBy: actor.id })
      .onConflictDoNothing()
      .returning({ id: collectionInvite.id });
    return ok(emailed ? { kind: "emailed" as const, inviteId: emailed.id } : null);
  }
  const [person] = await db
    .select({ id: profile.userId })
    .from(profile)
    .where(
      and(
        eq(sql`lower(${profile.username})`, (draft.username ?? "").toLowerCase()),
        not(hasBlocked(profile.userId, actor.id)),
      ),
    );
  if (!person) return err({ code: "not_found", message: "No one has that username" });
  if (person.id === actor.id) return err({ code: "validation_failed", message: "That's you" });
  if (person.id === ownerId) return err({ code: "validation_failed", message: "They own this collection" });
  if ((await db.$count(collectionMember, and(eq(collectionMember.collectionId, id), eq(collectionMember.userId, person.id)))) > 0) return ok(null);
  const asked = await db
    .delete(collectionRequest)
    .where(and(eq(collectionRequest.collectionId, id), eq(collectionRequest.userId, person.id)))
    .returning();
  if (asked.length > 0) {
    const joined = await join(db, id, person.id, draft.role);
    return joined.map(() => ({ kind: "added" as const, userId: person.id }));
  }
  const [inserted] = await db
    .insert(collectionInvite)
    .values({ id: sql`uuidv7()::text`, collectionId: id, userId: person.id, role: draft.role, invitedBy: actor.id })
    .onConflictDoUpdate({ target: [collectionInvite.collectionId, collectionInvite.userId], set: { role: draft.role } })
    .returning({ id: collectionInvite.id, createdAt: collectionInvite.createdAt });
  return ok(inserted ? { kind: "invited" as const, inviteId: inserted.id, userId: person.id } : null);
}

// The caller holds the collection's row lock, so concurrent joins can't pass the cap.
async function join(db: Database, id: string, userId: string, role: CollectionMemberRole): Promise<Result<void, AppError>> {
  if ((await db.$count(collectionMember, eq(collectionMember.collectionId, id))) >= MEMBER_LIMIT) {
    return err({ code: "validation_failed", message: `A collection can be shared with ${MEMBER_LIMIT} people` });
  }
  await db.insert(collectionMember).values({ collectionId: id, userId, role }).onConflictDoNothing();
  await db.delete(collectionInvite).where(and(eq(collectionInvite.collectionId, id), eq(collectionInvite.userId, userId)));
  await db.delete(collectionRequest).where(and(eq(collectionRequest.collectionId, id), eq(collectionRequest.userId, userId)));
  return ok(undefined);
}

const noInvitation: AppError = { code: "not_found", message: "No invitation to this collection" };

export async function acceptInvitation(db: Database, viewerId: string, id: string): Promise<Result<Collection, AppError>> {
  const accepted = await inTransaction(db, async (tx): Promise<Result<void, AppError>> => {
    await tx.select({ id: collection.id }).from(collection).where(eq(collection.id, id)).for("update");
    const [pending] = await tx
      .select({ role: collectionInvite.role })
      .from(collectionInvite)
      .where(and(eq(collectionInvite.collectionId, id), eq(collectionInvite.userId, viewerId)));
    if (!pending) {
      // Accepting twice lands where the first one did.
      const member = await tx.$count(collectionMember, and(eq(collectionMember.collectionId, id), eq(collectionMember.userId, viewerId)));
      return member > 0 ? ok(undefined) : err(noInvitation);
    }
    return join(tx, id, viewerId, pending.role);
  });
  return accepted.isErr() ? err(accepted.error) : readBack(db, viewerId, id);
}

/** One by email stays pending to the inviter, so declining doesn't tell them who you are. */
export async function declineInvitation(db: Database, viewerId: string, id: string): Promise<Result<{ declined: true }, AppError>> {
  const yours = and(eq(collectionInvite.collectionId, id), eq(collectionInvite.userId, viewerId));
  await db.transaction(async (tx) => {
    await tx.update(collectionInvite).set({ userId: null, declinedAt: new Date() }).where(and(yours, isNotNull(collectionInvite.emailHash)));
    await tx.delete(collectionInvite).where(yours);
  });
  return ok({ declined: true });
}

/** Answered the same whether it exists, you're blocked or you asked, so a link never confirms more than it did. */
export async function requestAccess(db: Database, viewerId: string, id: string): Promise<{ requested: true; newRequest: { ownerId: string; name: string } | null }> {
  const [row] = await db
    .select({
      ownerId: collection.ownerId,
      name: collection.name,
      inIt: sql<boolean>`(${collection.ownerId} = ${viewerId} or ${isMember(viewerId)})`,
      blocked: hasBlocked(collection.ownerId, viewerId),
      invited: sql<boolean>`exists (select 1 from ${collectionInvite} where ${collectionInvite.collectionId} = ${collection.id} and ${collectionInvite.userId} = ${viewerId})`,
    })
    .from(collection)
    .where(eq(collection.id, id));
  if (!row || row.inIt || row.blocked || row.invited) return { requested: true, newRequest: null };
  const inserted = await db.insert(collectionRequest).values({ collectionId: id, userId: viewerId }).onConflictDoNothing().returning();
  return { requested: true, newRequest: inserted.length > 0 ? { ownerId: row.ownerId, name: row.name } : null };
}

const noRequest: AppError = { code: "not_found", message: "They didn't ask to join" };

export async function approveRequest(
  db: Database,
  actorId: string,
  id: string,
  userId: string,
  role: CollectionMemberRole,
): Promise<Result<CollectionAccess, AppError>> {
  const allowed = await standing(db, actorId, id, "admin");
  if (allowed.isErr()) return err(allowed.error);
  const approved = await inTransaction(db, async (tx): Promise<Result<void, AppError>> => {
    await tx.select({ id: collection.id }).from(collection).where(eq(collection.id, id)).for("update");
    const asked = await tx.$count(collectionRequest, and(eq(collectionRequest.collectionId, id), eq(collectionRequest.userId, userId)));
    if (asked === 0) return err(noRequest);
    return join(tx, id, userId, role);
  });
  return approved.isErr() ? err(approved.error) : collectionAccess(db, actorId, id);
}

export async function declineRequest(db: Database, actorId: string, id: string, userId: string): Promise<Result<CollectionAccess, AppError>> {
  const allowed = await standing(db, actorId, id, "admin");
  if (allowed.isErr()) return err(allowed.error);
  await db.delete(collectionRequest).where(and(eq(collectionRequest.collectionId, id), eq(collectionRequest.userId, userId)));
  return collectionAccess(db, actorId, id);
}

export async function setMemberRole(
  db: Database,
  actorId: string,
  id: string,
  userId: string,
  role: CollectionMemberRole,
): Promise<Result<CollectionAccess, AppError>> {
  const allowed = await standing(db, actorId, id, "admin");
  if (allowed.isErr()) return err(allowed.error);
  const changed = await db
    .update(collectionMember)
    .set({ role })
    .where(and(eq(collectionMember.collectionId, id), eq(collectionMember.userId, userId)))
    .returning();
  if (changed.length === 0) return err({ code: "not_found", message: "They aren't in this collection" });
  return collectionAccess(db, actorId, id);
}

export async function removeMember(db: Database, actorId: string, id: string, userId: string): Promise<Result<{ removed: true }, AppError>> {
  if (actorId !== userId) {
    const allowed = await standing(db, actorId, id, "admin");
    if (allowed.isErr()) return err(allowed.error);
  }
  await db.delete(collectionMember).where(and(eq(collectionMember.collectionId, id), eq(collectionMember.userId, userId)));
  return ok({ removed: true });
}

export async function cancelInvite(db: Database, actorId: string, id: string, inviteId: string): Promise<Result<CollectionAccess, AppError>> {
  const allowed = await standing(db, actorId, id, "admin");
  if (allowed.isErr()) return err(allowed.error);
  await db.delete(collectionInvite).where(and(eq(collectionInvite.collectionId, id), eq(collectionInvite.id, inviteId)));
  return collectionAccess(db, actorId, id);
}

const notPrivateDestination: AppError = { code: "validation_failed", message: "Private spots go into a private collection you edit" };

export async function privateDestination(db: Database, actorId: string, id: string): Promise<Result<void, AppError>> {
  const allowed = await standing(db, actorId, id, "editor");
  return allowed.isOk() && allowed.value.visibility === "private" ? ok(undefined) : err(notPrivateDestination);
}

export async function collectionManagers(db: Database, id: string): Promise<string[]> {
  const rows = await db
    .select({ id: collection.ownerId })
    .from(collection)
    .where(eq(collection.id, id))
    .union(db.select({ id: collectionMember.userId }).from(collectionMember).where(and(eq(collectionMember.collectionId, id), eq(collectionMember.role, "admin"))));
  return rows.map((row) => row.id);
}

export async function favorite(db: Database, viewerId: string, spotId: string, starred: boolean): Promise<Result<Collection, AppError>> {
  const id = await favoritesOf(db, viewerId);
  return starred ? addSpot(db, viewerId, id, spotId) : removeSpot(db, viewerId, id, spotId);
}
