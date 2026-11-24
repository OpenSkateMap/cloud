import { z } from "@hono/zod-openapi";
import type { Database } from "@openskatemap/db";
import { clipUpload, reviewEvent, SPOT_CONDITIONS, SPOT_EDIT_FIELDS, SPOT_KINDS, spot, spotPhoto, submission, submissionPhoto, user } from "@openskatemap/db/schema";
import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { PgInsertValue } from "drizzle-orm/pg-core";
import type { AppError } from "../lib/errors.ts";
import { type Attempt, err, ok, type Result, safeTry } from "../lib/result.ts";
import { draftClipIds, type SpotEditDraft, type SpotEdits, type Submission } from "../lib/submission-schemas.ts";
import { requireClips } from "./clips.ts";
import { requireUploads } from "./photos.ts";
import { creditColumns, type EntryPhoto, loadSubmissions, pickPhotos, submissionPhotoRows, uploadedPhoto } from "./submissions.ts";
import { inTransaction } from "../lib/transaction";
import { mergePhotoOrder, sameIds } from "../lib/photo-order.ts";

type SpotField = (typeof SPOT_EDIT_FIELDS)[number];

const SpotValuesSchema = z.object({
  title: z.string(),
  description: z.string(),
  spotKind: z.enum(SPOT_KINDS),
  obstacles: z.array(z.string()),
  condition: z.enum(SPOT_CONDITIONS),
  location: z.object({ latitude: z.number(), longitude: z.number() }),
});
export type SpotValues = z.infer<typeof SpotValuesSchema>;
type Location = SpotValues["location"];

const ValuesRecordSchema = SpotValuesSchema.partial();
const StoredSpotPhotoSchema = z.object({
  id: z.string(),
  r2Key: z.string(),
  width: z.int(),
  height: z.int(),
  thumbhash: z.string(),
  credit: z.string().nullable(),
  hasPermission: z.boolean(),
  sourceUrl: z.string().nullable(),
  uploadedBy: z.string().nullable(),
  position: z.int(),
  createdAt: z.coerce.date(),
  // Approvals recorded before clips existed have none.
  clipId: z.string().nullable().default(null),
});
const PhotoChangeSchema = z.object({ before: z.array(StoredSpotPhotoSchema), after: z.array(z.string()) });
const ApprovedEditSchema = z.object({
  previous: ValuesRecordSchema,
  applied: ValuesRecordSchema,
  addedPhotoIds: z.array(z.string()),
  photos: PhotoChangeSchema.optional(),
});
type ValuesRecord = z.infer<typeof ValuesRecordSchema>;
type PhotoChange = z.infer<typeof PhotoChangeSchema>;

/** `base` with the fields `changes` sets; the pin moves only with both coordinates. */
export function withChanges(base: SpotValues, changes: Omit<SpotEdits, "photoIds">): SpotValues {
  return {
    title: changes.title ?? base.title,
    description: changes.description ?? base.description,
    spotKind: changes.spotKind ?? base.spotKind,
    obstacles: changes.obstacles ?? base.obstacles,
    condition: changes.condition ?? base.condition,
    location:
      changes.latitude !== undefined && changes.longitude !== undefined ? { latitude: changes.latitude, longitude: changes.longitude } : base.location,
  };
}

const noSuchSpot: AppError = { code: "not_found", message: "No such spot to suggest an edit to" };

const sameObstacles = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");
const sameLocation = (a: Location, b: Location) => a.latitude === b.latitude && a.longitude === b.longitude;

function same<K extends keyof SpotValues>(field: K, a: SpotValues[K], b: SpotValues[K]): boolean {
  if (field === "obstacles") return sameObstacles(a as string[], b as string[]);
  if (field === "location") return sameLocation(a as Location, b as Location);
  return a === b;
}

const valueFields = ["title", "description", "spotKind", "obstacles", "condition", "location"] as const satisfies readonly (keyof SpotValues)[];

/** SQL: a spot edits may change (and the review card shows as it is now). */
export const isEditableSpot = sql<boolean>`(${spot.status} = 'published' and ${spot.visibility} = 'public')`;

/** SQL, beside a submission and its spot: how many of the spot's photos the edit removes (in its base, still there, not kept). */
export const editRemovedPhotoCount = sql<number>`(
  select count(*) from ${spotPhoto}
  where ${spotPhoto.spotId} = ${spot.id} and 'photos' = any(${submission.changedFields}) and ${spotPhoto.id} = any(${submission.basePhotoIds})
    and not exists (select 1 from ${submissionPhoto} where ${submissionPhoto.submissionId} = ${submission.id} and ${submissionPhoto.spotPhotoId} = ${spotPhoto.id})
)`.mapWith(Number);

async function editableSpot(db: Database, spotId: string, { forUpdate = false } = {}): Promise<SpotValues | undefined> {
  const query = db
    .select({
      title: spot.title,
      description: spot.description,
      spotKind: spot.kind,
      obstacles: spot.obstacles,
      condition: spot.condition,
      location: spot.location,
    })
    .from(spot)
    .where(and(eq(spot.id, spotId), isEditableSpot));
  const [row] = forUpdate ? await query.for("update") : await query;
  return row;
}

const spotPhotos = (db: Database, spotId: string) =>
  db.select().from(spotPhoto).where(eq(spotPhoto.spotId, spotId)).orderBy(asc(spotPhoto.position));

type PhotoSlot = string | Omit<PgInsertValue<typeof spotPhoto>, "spotId" | "position">;

/** The spot's photos become `slots`, in order: its own by id (any not named are deleted) and new rows. */
async function setPhotos(tx: Database, spotId: string, slots: readonly PhotoSlot[]) {
  const staying = slots.filter((slot) => typeof slot === "string");
  await tx.delete(spotPhoto).where(staying.length === 0 ? eq(spotPhoto.spotId, spotId) : and(eq(spotPhoto.spotId, spotId), notInArray(spotPhoto.id, staying)));
  // `(spot_id, position)` is unique and checked row by row: the photos staying step aside before any takes its new place.
  await tx.update(spotPhoto).set({ position: sql`-1 - ${spotPhoto.position}` }).where(eq(spotPhoto.spotId, spotId));
  const added = slots.flatMap((slot, position) => (typeof slot === "string" ? [] : [{ ...slot, spotId, position }]));
  if (added.length > 0) await tx.insert(spotPhoto).values(added);
  const placed = slots.flatMap((slot, position) => (typeof slot === "string" ? [sql`(${slot}, ${position}::int)`] : []));
  if (placed.length > 0) {
    await tx.execute(sql`
      update ${spotPhoto} set position = placed.position
      from (values ${sql.join(placed, sql`, `)}) as placed(id, position)
      where ${spotPhoto.id} = placed.id and ${spotPhoto.spotId} = ${spotId}`);
  }
}

type StoredEdit = Pick<typeof submission.$inferSelect, "submittedBy" | "kind" | "status">;

function ownEdit(row: StoredEdit, submitterId: string): Result<void, AppError> {
  if (row.submittedBy !== submitterId) return err({ code: "forbidden", message: "This submission id belongs to someone else" });
  if (row.kind !== "edit_spot") return err({ code: "conflict", message: "This id was already used for a new spot" });
  return ok(undefined);
}

async function readEdit(db: Database, id: string): Promise<Result<Submission, AppError>> {
  const [saved] = await loadSubmissions(db, eq(submission.id, id));
  return saved ? ok(saved) : err({ code: "internal_error", message: "The edit was saved but could not be read back" });
}

export async function saveSpotEdit(db: Database, submitterId: string, id: string, draft: SpotEditDraft): Promise<Result<Submission, AppError>> {
  const [earlier] = await db.select({ submittedBy: submission.submittedBy, kind: submission.kind, status: submission.status }).from(submission).where(eq(submission.id, id));
  if (earlier) {
    const owned = ownEdit(earlier, submitterId);
    if (owned.isErr()) return err(owned.error);
    // A resend of a decided edit gets the decision, though the spot may already say what it asked for.
    if (earlier.status !== "pending") return readEdit(db, id);
  }
  const uploaded = await requireUploads(db, submitterId, draft.photos.map((photo) => photo.photoId));
  if (uploaded.isErr()) return err(uploaded.error);
  const clipped = await requireClips(db, submitterId, draftClipIds(draft.photos));
  if (clipped.isErr()) return err(clipped.error);
  const current = await editableSpot(db, draft.spotId);
  if (!current) return err(noSuchSpot);
  const currentPhotos = await spotPhotos(db, draft.spotId);
  const photos = editPhotos(id, draft, currentPhotos);
  if (photos.isErr()) return err(photos.error);
  const { basePhotoIds, entries, photosChange } = photos.value;

  const proposed = withChanges(current, draft.changes);
  const changedFields: SpotField[] = valueFields.filter((field) => !same(field, current[field], proposed[field]));
  if (photosChange) changedFields.push("photos");
  if (changedFields.length === 0) return err({ code: "validation_failed", message: "Nothing to change: the spot already says this" });

  const stored: SpotValues = { ...current };
  for (const field of valueFields) {
    if (changedFields.includes(field)) Object.assign(stored, { [field]: proposed[field] });
  }
  const fields = { ...stored, note: draft.note, spotId: draft.spotId, changedFields, basePhotoIds, collectionId: null };
  const written = await inTransaction(db, (tx) => safeTry(async function* (): Attempt<void, AppError> {
    await tx.insert(submission).values({ id, kind: "edit_spot", submittedBy: submitterId, ...fields }).onConflictDoNothing();
    const [row] = await tx
      .select({ submittedBy: submission.submittedBy, status: submission.status, kind: submission.kind })
      .from(submission)
      .where(eq(submission.id, id))
      .for("update");
    if (!row) return err({ code: "internal_error", message: "The edit was not saved" });
    yield* ownEdit(row, submitterId);
    if (row.status !== "pending") return ok(undefined);
    await tx.update(submission).set(fields).where(eq(submission.id, id));
    await tx.delete(submissionPhoto).where(eq(submissionPhoto.submissionId, id));
    if (photosChange && entries.length > 0) await tx.insert(submissionPhoto).values(entries);
    return ok(undefined);
  }));
  return written.isErr() ? err(written.error) : readEdit(db, id);
}

type EditPhotos = { basePhotoIds: string[] | null; entries: (typeof submissionPhoto.$inferInsert)[]; photosChange: boolean };
type EntryRow = Omit<typeof submissionPhoto.$inferInsert, "submissionId" | "position">;

function editPhotos(id: string, draft: SpotEditDraft, currentPhotos: (typeof spotPhoto.$inferSelect)[]): Result<EditPhotos, AppError> {
  const placed = (rows: EntryRow[]) => rows.map((row, position) => ({ ...row, submissionId: id, position }));
  const newPhoto = (photo: SpotEditDraft["photos"][number]): EntryRow => ({
    photoId: photo.photoId,
    clipId: photo.clipId ?? null,
    thumbhash: photo.thumbhash,
    ...creditColumns(photo.credit),
  });
  if (draft.photoEdit === undefined) {
    return ok({ basePhotoIds: null, entries: placed(draft.photos.map(newPhoto)), photosChange: draft.photos.length > 0 });
  }
  const { order } = draft.photoEdit;
  const onSpot = new Map(currentPhotos.map((photo) => [photo.id, photo]));
  // Photos gone by now leave the base, so one an undo brings back counts as gained since and stays.
  const base = draft.photoEdit.base.filter((photoId) => onSpot.has(photoId));
  const uploads = new Map(draft.photos.map((photo) => [photo.photoId, photo]));
  const known = new Set([...draft.photoEdit.base, ...uploads.keys()]);
  if (order.some((photoId) => !known.has(photoId))) {
    return err({ code: "validation_failed", message: "photoEdit.order names a photo that is in neither its base nor photos" });
  }
  if (draft.photos.some((photo) => !order.includes(photo.photoId))) {
    return err({ code: "validation_failed", message: "Place every new photo in photoEdit.order" });
  }
  const entries = placed(
    order.flatMap((photoId): EntryRow[] => {
      const upload = uploads.get(photoId);
      if (upload) return [newPhoto(upload)];
      const photo = onSpot.get(photoId);
      // A photo the editor showed that's gone since stays gone.
      if (!photo) return [];
      const { thumbhash, credit, hasPermission, sourceUrl } = photo;
      return [{ spotPhotoId: photoId, thumbhash, credit, hasPermission, sourceUrl }];
    }),
  );
  const current = currentPhotos.map((photo) => photo.id);
  const photosChange = uploads.size > 0 || !sameIds(mergePhotoOrder<never>({ base, edit: order, current }), current);
  return ok({ basePhotoIds: base, entries, photosChange });
}

export type EditRow = SpotValues & { spotId: string | null; changedFields: SpotField[]; basePhotoIds: string[] | null };

/** An app that shows an edit's photos as additions would approve removals its reviewer never saw. */
export function reviewableEdit(row: Pick<EditRow, "changedFields" | "basePhotoIds">, wholePhotoList: boolean): Result<void, AppError> {
  if (row.basePhotoIds === null || !row.changedFields.includes("photos") || wholePhotoList) return ok(undefined);
  return err({ code: "validation_failed", message: "Update OpenSkateMap to review changes to a spot's photos" });
}

export async function applyEdit(
  tx: Database,
  submissionId: string,
  row: EditRow,
  edits: SpotEdits,
  checkPlace: (location: Location) => Promise<Result<void, AppError>>,
): Promise<Result<z.infer<typeof ApprovedEditSchema> & { spotId: string }, AppError>> {
  if (row.spotId === null) return err({ code: "conflict", message: "The spot this edit was for is gone" });
  const current = await editableSpot(tx, row.spotId, { forUpdate: true });
  if (!current) return err({ code: "conflict", message: "The spot this edit was for is gone" });

  const suggested = withChanges(row, edits);
  const previous: ValuesRecord = {};
  const applied: ValuesRecord = {};
  for (const field of valueFields) {
    if (!row.changedFields.includes(field)) continue;
    Object.assign(previous, { [field]: current[field] });
    Object.assign(applied, { [field]: suggested[field] });
  }
  if (applied.location !== undefined && !sameLocation(applied.location, current.location)) {
    const allowed = await checkPlace(applied.location);
    if (allowed.isErr()) return err(allowed.error);
  }

  const update = {
    ...(applied.title === undefined ? {} : { title: applied.title }),
    ...(applied.description === undefined ? {} : { description: applied.description }),
    ...(applied.spotKind === undefined ? {} : { kind: applied.spotKind }),
    ...(applied.obstacles === undefined ? {} : { obstacles: applied.obstacles }),
    ...(applied.condition === undefined ? {} : { condition: applied.condition }),
    ...(applied.location === undefined ? {} : { location: applied.location }),
  };
  if (Object.keys(update).length > 0) {
    await tx.update(spot).set({ ...update, updatedAt: new Date() }).where(eq(spot.id, row.spotId));
  }

  let addedPhotoIds: string[] = [];
  let photos: PhotoChange | undefined;
  if (row.changedFields.includes("photos")) {
    const picked = pickPhotos(await submissionPhotoRows(tx, submissionId), edits.photoIds);
    if (picked === undefined) return err({ code: "validation_failed", message: "Choose photos from this edit only" });
    if (row.basePhotoIds === null) {
      addedPhotoIds = await appendPhotos(tx, row.spotId, picked);
    } else {
      photos = await replacePhotos(tx, row.spotId, row.basePhotoIds, picked);
    }
  }
  return ok({ spotId: row.spotId, previous, applied, addedPhotoIds, ...(photos === undefined ? {} : { photos }) });
}

async function appendPhotos(tx: Database, spotId: string, added: EntryPhoto[]): Promise<string[]> {
  if (added.length === 0) return [];
  const [last] = await tx.select({ position: spotPhoto.position }).from(spotPhoto).where(eq(spotPhoto.spotId, spotId)).orderBy(desc(spotPhoto.position)).limit(1);
  const start = (last?.position ?? -1) + 1;
  const inserted = await tx
    .insert(spotPhoto)
    .values(added.map((photo, index) => ({ ...uploadedPhoto(photo), id: sql`uuidv7()::text`, spotId, position: start + index })))
    .returning({ id: spotPhoto.id });
  return inserted.map((photo) => photo.id);
}

async function replacePhotos(tx: Database, spotId: string, base: readonly string[], entries: EntryPhoto[]): Promise<PhotoChange> {
  const before = await spotPhotos(tx, spotId);
  const edit = entries.map((entry) => entry.spotPhotoId ?? { ...uploadedPhoto(entry), id: sql`uuidv7()::text` });
  await setPhotos(tx, spotId, mergePhotoOrder({ base, edit, current: before.map((photo) => photo.id) }));
  return { before, after: (await spotPhotos(tx, spotId)).map((photo) => photo.id) };
}

export async function revertEdit(tx: Database, submissionId: string, spotId: string | null): Promise<Result<void, AppError>> {
  if (spotId === null) return ok(undefined);
  const [event] = await tx
    .select({ details: reviewEvent.details })
    .from(reviewEvent)
    .where(and(eq(reviewEvent.submissionId, submissionId), eq(reviewEvent.action, "approve")))
    .orderBy(desc(reviewEvent.id))
    .limit(1);
  const approved = ApprovedEditSchema.safeParse(event?.details);
  if (!approved.success) return err({ code: "internal_error", message: "The approval to undo wasn't recorded in a known shape" });
  const current = await editableSpot(tx, spotId, { forUpdate: true });
  if (current) {
    const { previous, applied } = approved.data;
    const restore: Partial<SpotValues> = {};
    for (const field of valueFields) {
      const was = previous[field];
      const set = applied[field];
      if (was === undefined || set === undefined) continue;
      if (same(field, current[field], set as SpotValues[typeof field])) Object.assign(restore, { [field]: was });
    }
    const { spotKind, ...rest } = restore;
    if (Object.keys(restore).length > 0) {
      await tx.update(spot).set({ ...rest, ...(spotKind === undefined ? {} : { kind: spotKind }), updatedAt: new Date() }).where(eq(spot.id, spotId));
    }
  }
  if (approved.data.addedPhotoIds.length > 0) {
    await tx.delete(spotPhoto).where(and(eq(spotPhoto.spotId, spotId), inArray(spotPhoto.id, approved.data.addedPhotoIds)));
  }
  if (approved.data.photos !== undefined) await restorePhotos(tx, spotId, approved.data.photos);
  return ok(undefined);
}

/** Only while the spot's photos are still what the approval left. */
async function restorePhotos(tx: Database, spotId: string, { before, after }: PhotoChange) {
  const now = (await spotPhotos(tx, spotId)).map((photo) => photo.id);
  if (!sameIds(now, after)) return;
  const returning = before.filter((photo) => !now.includes(photo.id));
  const uploaders = [...new Set(returning.flatMap((photo) => (photo.uploadedBy === null ? [] : [photo.uploadedBy])))];
  // An uploader may have deleted their account since; their photos stay, unattributed.
  const accounts = uploaders.length === 0 ? [] : await tx.select({ id: user.id }).from(user).where(inArray(user.id, uploaders));
  const alive = new Set(accounts.map((account) => account.id));
  // A clip nothing played while the photo was away may have been swept; the photo comes back without it.
  const clipIds = [...new Set(returning.flatMap((photo) => (photo.clipId === null ? [] : [photo.clipId])))];
  const clips = clipIds.length === 0 ? [] : await tx.select({ id: clipUpload.id }).from(clipUpload).where(inArray(clipUpload.id, clipIds));
  const kept = new Set(clips.map((clip) => clip.id));
  await setPhotos(
    tx,
    spotId,
    before.map(({ position: _, ...photo }) =>
      now.includes(photo.id)
        ? photo.id
        : {
            ...photo,
            uploadedBy: photo.uploadedBy !== null && alive.has(photo.uploadedBy) ? photo.uploadedBy : null,
            clipId: photo.clipId !== null && kept.has(photo.clipId) ? photo.clipId : null,
          },
    ),
  );
}
