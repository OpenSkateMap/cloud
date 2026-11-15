import type { Database } from "@openskatemap/db";
import { collection, collectionSpot, photoUpload, reviewEvent, spot, spotPhoto, submission, submissionPhoto } from "@openskatemap/db/schema";
import { and, asc, desc, eq, exists, inArray, isNotNull, type SQL, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import type { AppError } from "../lib/errors.ts";
import { err, ok, type Result } from "../lib/result.ts";
import type { NewSpotDraft, PhotoCredit, Submission } from "../lib/submission-schemas.ts";
import { privateDestination } from "./collections.ts";
import { requireUploads } from "./photos.ts";
import { inTransaction } from "../lib/transaction";

const HISTORY_LIMIT = 200;

/** SQL: a private submission. Read from its spot too, since deleting the collection clears `collection_id`. */
export const isPrivateSubmission = sql<boolean>`(${submission.collectionId} is not null or exists (
  select 1 from ${spot} where ${spot.id} = ${submission.spotId} and ${spot.visibility} = 'private'
))`;

/** Its spot was taken down by an admin: profile stats leave it out; the rider's history shows it as removed. */
export const isTakenDown = exists(
  new QueryBuilder()
    .select({ id: spot.id })
    .from(spot)
    .where(and(eq(spot.id, submission.spotId), isNotNull(spot.removalReason))),
);

export const creditColumns = (credit: PhotoCredit) =>
  credit.takenBy === "submitter"
    ? { credit: null, hasPermission: true, sourceUrl: null }
    : { credit: credit.credit, hasPermission: true, sourceUrl: credit.sourceUrl ?? null };

const toCredit = ({ credit, sourceUrl }: { credit: string | null; sourceUrl: string | null }): PhotoCredit =>
  credit === null
    ? { takenBy: "submitter" }
    : { takenBy: "someone_else", credit, hasPermission: true, ...(sourceUrl === null ? {} : { sourceUrl }) };

export async function saveSubmission(db: Database, submitterId: string, id: string, draft: NewSpotDraft): Promise<Result<Submission, AppError>> {
  const uploaded = await requireUploads(db, submitterId, draft.photos.map((photo) => photo.photoId));
  if (uploaded.isErr()) return err(uploaded.error);

  if (draft.collectionId !== undefined) {
    const destination = await privateDestination(db, submitterId, draft.collectionId);
    if (destination.isErr()) return err(destination.error);
  }

  const fields = {
    title: draft.title,
    description: draft.description,
    spotKind: draft.spotKind,
    obstacles: draft.obstacles,
    condition: draft.condition,
    location: { latitude: draft.latitude, longitude: draft.longitude },
    note: draft.note,
    collectionId: draft.collectionId ?? null,
  };
  const written = await inTransaction(db, async (tx): Promise<Result<void, AppError>> => {
    await tx.insert(submission).values({ id, kind: draft.kind, submittedBy: submitterId, ...fields }).onConflictDoNothing();
    const [row] = await tx
      .select({ submittedBy: submission.submittedBy, status: submission.status, kind: submission.kind })
      .from(submission)
      .where(eq(submission.id, id))
      .for("update");
    if (row?.submittedBy !== submitterId) return err({ code: "forbidden", message: "This submission id belongs to someone else" });
    if (row.kind !== draft.kind) return err({ code: "conflict", message: "This id was already used for a suggested edit" });
    if (row.status !== "pending") return ok(undefined);
    await tx.update(submission).set(fields).where(eq(submission.id, id));
    await tx.delete(submissionPhoto).where(eq(submissionPhoto.submissionId, id));
    if (draft.photos.length > 0) {
      await tx.insert(submissionPhoto).values(
        draft.photos.map((photo, position) => ({ submissionId: id, photoId: photo.photoId, position, thumbhash: photo.thumbhash, ...creditColumns(photo.credit) })),
      );
    }
    if (draft.collectionId !== undefined) await publishPrivately(tx, submitterId, id, draft.collectionId);
    return ok(undefined);
  });
  if (written.isErr()) return err(written.error);

  const [saved] = await loadSubmissions(db, eq(submission.id, id));
  return saved ? ok(saved) : err({ code: "internal_error", message: "The submission was saved but could not be read back" });
}

// An entry is a new upload or, in an edit, one of the spot's own photos: its id and file come from whichever it is.
const entryPhoto = {
  photoId: sql<string>`coalesce(${submissionPhoto.photoId}, ${submissionPhoto.spotPhotoId})`,
  spotPhotoId: submissionPhoto.spotPhotoId,
  r2Key: sql<string>`coalesce(${photoUpload.r2Key}, ${spotPhoto.r2Key})`,
  width: sql<number>`coalesce(${photoUpload.width}, ${spotPhoto.width})`,
  height: sql<number>`coalesce(${photoUpload.height}, ${spotPhoto.height})`,
};
// A spot photo an edit kept may be gone since; an undo can bring it back under the same id.
const entryExists = sql<boolean>`(${submissionPhoto.photoId} is not null or ${spotPhoto.id} is not null)`;

export function submissionPhotoRows(db: Database, submissionId: string) {
  return db
    .select({
      ...entryPhoto,
      uploadedBy: photoUpload.uploadedBy,
      thumbhash: submissionPhoto.thumbhash,
      credit: submissionPhoto.credit,
      hasPermission: submissionPhoto.hasPermission,
      sourceUrl: submissionPhoto.sourceUrl,
    })
    .from(submissionPhoto)
    .leftJoin(photoUpload, eq(photoUpload.id, submissionPhoto.photoId))
    .leftJoin(spotPhoto, eq(spotPhoto.id, submissionPhoto.spotPhotoId))
    .where(and(eq(submissionPhoto.submissionId, submissionId), entryExists))
    .orderBy(asc(submissionPhoto.position));
}

export type EntryPhoto = Awaited<ReturnType<typeof submissionPhotoRows>>[number];

export const uploadedPhoto = ({ photoId: _, spotPhotoId: __, ...photo }: EntryPhoto) => photo;

/** The photos `ids` names, in that order (all of them without `ids`); undefined when one isn't among `rows`. */
export function pickPhotos<Row extends { photoId: string }>(rows: Row[], ids: readonly string[] | undefined): Row[] | undefined {
  if (ids === undefined) return rows;
  const byId = new Map(rows.map((row) => [row.photoId, row]));
  const picked = ids.map((id) => byId.get(id)).filter((row) => row !== undefined);
  return picked.length === ids.length ? picked : undefined;
}

async function publishPrivately(tx: Database, submitterId: string, submissionId: string, collectionId: string) {
  const [row] = await tx.select().from(submission).where(eq(submission.id, submissionId));
  if (!row) return;
  const photos = await submissionPhotoRows(tx, submissionId);
  const [created] = await tx
    .insert(spot)
    .values({
      id: sql`uuidv7()::text`,
      status: "published",
      visibility: "private",
      title: row.title,
      description: row.description,
      kind: row.spotKind,
      obstacles: row.obstacles,
      condition: row.condition,
      location: row.location,
      createdBy: submitterId,
    })
    .returning({ id: spot.id });
  if (!created) throw new Error("The private spot was not created");
  if (photos.length > 0) {
    await tx.insert(spotPhoto).values(photos.map((photo, position) => ({ ...uploadedPhoto(photo), id: sql`uuidv7()::text`, spotId: created.id, position })));
  }
  await tx.insert(collectionSpot).values({ collectionId, spotId: created.id, addedBy: submitterId }).onConflictDoNothing();
  await tx.update(collection).set({ updatedAt: new Date() }).where(eq(collection.id, collectionId));
  await tx
    .update(submission)
    .set({ status: "approved", spotId: created.id, reviewedBy: submitterId, reviewedAt: new Date() })
    .where(eq(submission.id, submissionId));
  await tx.insert(reviewEvent).values({ submissionId, actorId: submitterId, action: "approve", details: { spotId: created.id, private: true, collectionId } });
}

export function mySubmissions(db: Database, userId: string) {
  return loadSubmissions(db, eq(submission.submittedBy, userId));
}

export async function loadSubmissions(
  db: Database,
  where: SQL | undefined,
  { order = "newest", limit = HISTORY_LIMIT }: { order?: "newest" | "oldest"; limit?: number } = {},
): Promise<Submission[]> {
  const rows = await db
    .select({
      id: submission.id,
      kind: submission.kind,
      status: submission.status,
      title: submission.title,
      description: submission.description,
      spotKind: submission.spotKind,
      obstacles: submission.obstacles,
      condition: submission.condition,
      location: submission.location,
      cityId: submission.cityId,
      note: submission.note,
      spotId: submission.spotId,
      changedFields: submission.changedFields,
      collectionId: submission.collectionId,
      rejectReason: submission.rejectReason,
      removalReason: spot.removalReason,
      removedAt: spot.removedAt,
      createdAt: submission.createdAt,
      updatedAt: submission.updatedAt,
    })
    .from(submission)
    .leftJoin(spot, eq(spot.id, submission.spotId))
    .where(where)
    .orderBy(order === "newest" ? desc(submission.createdAt) : asc(submission.createdAt))
    .limit(limit);
  const photos =
    rows.length === 0
      ? []
      : await db
          .select({
            submissionId: submissionPhoto.submissionId,
            ...entryPhoto,
            thumbhash: submissionPhoto.thumbhash,
            credit: submissionPhoto.credit,
            sourceUrl: submissionPhoto.sourceUrl,
            position: submissionPhoto.position,
          })
          .from(submissionPhoto)
          .leftJoin(photoUpload, eq(photoUpload.id, submissionPhoto.photoId))
          .leftJoin(spotPhoto, eq(spotPhoto.id, submissionPhoto.spotPhotoId))
          .where(and(inArray(submissionPhoto.submissionId, rows.map((row) => row.id)), entryExists))
          .orderBy(asc(submissionPhoto.position));
  const photosBySubmission = Map.groupBy(photos, (photo) => photo.submissionId);
  return rows.map(({ location, removalReason, removedAt, createdAt, updatedAt, ...row }) => ({
    ...row,
    ...location,
    removal: removalReason !== null && removedAt !== null ? { reason: removalReason, removedAt: removedAt.toISOString() } : null,
    photos: (photosBySubmission.get(row.id) ?? []).map(({ submissionId: _, spotPhotoId, r2Key, credit, sourceUrl, ...photo }) => ({
      ...photo,
      key: r2Key,
      credit: toCredit({ credit, sourceUrl }),
      existing: spotPhotoId !== null,
    })),
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  }));
}
