import type { Database } from "@openskatemap/db";
import { cityEditor, reviewEvent, spot, spotPhoto, submission, user } from "@openskatemap/db/schema";
import { and, desc, eq, inArray, not, or, type SQL, sql } from "drizzle-orm";
import type { CurrentUser } from "../env.ts";
import type { AppError } from "../lib/errors.ts";
import { type Attempt, err, ok, type Result, safeTry } from "../lib/result.ts";
import type { ReviewQueue, SpotEdits, SpotSnapshot, Submission } from "../lib/submission-schemas.ts";
import { applyEdit, editRemovedPhotoCount, isEditableSpot, reviewableEdit, revertEdit, type SpotValues, withChanges } from "./spot-edits.ts";
import { nearbySubmissions } from "./spots.ts";
import { isPrivateSubmission, loadSubmissions, pickPhotos, submissionPhotoRows, uploadedPhoto } from "./submissions.ts";
import { pendingVideos } from "./videos.ts";
import { inTransaction } from "../lib/transaction";

type RejectReason = NonNullable<Submission["rejectReason"]>;

const UNDO_WINDOW_MS = 10 * 60 * 1000;
const NEARBY_METERS = 150;

export type Scope = { readonly everywhere: true } | { readonly everywhere: false; readonly cityIds: readonly string[] };

export async function reviewScope(db: Database, actor: CurrentUser): Promise<Scope> {
  if (actor.role === "admin") return { everywhere: true };
  // A city_editor row left behind when someone stops being an editor grants nothing.
  if (actor.role !== "editor") return { everywhere: false, cityIds: [] };
  const rows = await db.select({ cityId: cityEditor.cityId }).from(cityEditor).where(eq(cityEditor.userId, actor.id));
  return { everywhere: false, cityIds: rows.map((row) => row.cityId) };
}

export const covers = (scope: Scope, cityId: string | null) => scope.everywhere || (cityId !== null && scope.cityIds.includes(cityId));

export type ReviewerRole = "curator" | "owner";

/** A curator decides only where they cover all of these: an edit's `fromCityId` too, so nobody moves a spot out of a city they don't curate. */
export const curatorCities = (item: { cityId: string | null; fromCityId?: string | null | undefined }) =>
  item.fromCityId === undefined ? [item.cityId] : [item.cityId, item.fromCityId];

export function reviewerRole(
  scope: Scope,
  actorId: string,
  item: { cityId: string | null; fromCityId?: string | null | undefined; spotOwnerId: string | null; submittedBy: string | null },
): ReviewerRole | undefined {
  if (curatorCities(item).every((cityId) => covers(scope, cityId))) return "curator";
  if (item.spotOwnerId === actorId && item.submittedBy !== actorId) return "owner";
  return undefined;
}

export const changesToSpotsOf = (actorId: string) =>
  sql`(${submission.kind} = 'edit_spot' and ${submission.submittedBy} is distinct from ${actorId} and exists (
    select 1 from ${spot} where ${spot.id} = ${submission.spotId} and ${spot.createdBy} = ${actorId}
  ))`;

const outsideScope: AppError = { code: "forbidden", message: "You don't review this submission" };
const notReviewed: AppError = { code: "forbidden", message: "A private spot isn't reviewed" };

/** Still pending as the reviewer saw it (`seenUpdatedAt`), so nobody decides content they never looked at. */
export function decidable(what: "submission" | "video", row: { status: string; updatedAt: Date }, seenUpdatedAt: string): Result<void, AppError> {
  if (row.status !== "pending") return err({ code: "conflict", message: `This ${what} was already ${row.status}` });
  if (row.updatedAt.getTime() !== Date.parse(seenUpdatedAt)) {
    return err({ code: "conflict", message: `The ${what} changed since you opened it; reload it first` });
  }
  return ok(undefined);
}

export function mayUndo(actor: CurrentUser, row: { reviewedBy: string | null; reviewedAt: Date | null }): Result<void, AppError> {
  const own = row.reviewedBy === actor.id && row.reviewedAt !== null && Date.now() - row.reviewedAt.getTime() <= UNDO_WINDOW_MS;
  return actor.role === "admin" || own ? ok(undefined) : err({ code: "forbidden", message: "Only the reviewer can undo a decision, within ten minutes" });
}

/** Undoing what's already pending repeats your own undo, or there's nothing to undo. `events` picks the row's events. */
export async function repeatedUndo(tx: Database, actorId: string, events: SQL): Promise<Result<void, AppError>> {
  const [last] = await tx
    .select({ action: reviewEvent.action, actorId: reviewEvent.actorId })
    .from(reviewEvent)
    .where(events)
    .orderBy(desc(reviewEvent.id))
    .limit(1);
  return last?.action === "undo" && last.actorId === actorId ? ok(undefined) : err({ code: "conflict", message: "There is no decision to undo" });
}

export async function reviewQueue(db: Database, actor: CurrentUser, cityId: string | undefined, limit: number): Promise<ReviewQueue> {
  const scope = await reviewScope(db, actor);
  const covered = (column: typeof submission.cityId | typeof spot.cityId) =>
    scope.everywhere ? sql`true` : scope.cityIds.length > 0 ? inArray(column, [...scope.cityIds]) : sql`false`;
  // In SQL, before the limit: an edit is a curator's only when they also cover the spot's city now (`reviewerRole`).
  const curated = and(
    covered(submission.cityId),
    sql`(${submission.kind} <> 'edit_spot' or exists (select 1 from ${spot} where ${spot.id} = ${submission.spotId} and ${covered(spot.cityId)}))`,
  );
  const pending = await loadSubmissions(
    db,
    and(
      eq(submission.status, "pending"),
      not(isPrivateSubmission),
      cityId === undefined ? undefined : eq(submission.cityId, cityId),
      or(curated, changesToSpotsOf(actor.id)),
    ),
    { order: "oldest", limit },
  );

  const details = await cardDetails(db, pending.map((item) => item.id));
  const cards = pending.flatMap((item) => {
    const card = details.get(item.id);
    const reviewAs = reviewerRole(scope, actor.id, {
      cityId: item.cityId,
      fromCityId: item.kind === "edit_spot" ? (card?.spotCityId ?? null) : undefined,
      spotOwnerId: card?.spotOwnerId ?? null,
      submittedBy: card?.submitter?.id ?? null,
    });
    return reviewAs === undefined ? [] : [{ ...item, submitter: card?.submitter ?? null, current: card?.current ?? null, reviewAs }];
  });
  const nearby = await nearbySubmissions(db, cards.filter((item) => item.kind !== "edit_spot").map((item) => item.id), NEARBY_METERS);
  const items = cards.map((item) => ({ ...item, nearby: nearby.get(item.id) ?? [] }));
  const cityIds = scope.everywhere ? null : [...scope.cityIds];
  const videos = (await pendingVideos(db, { id: actor.id, cityIds }, cityId, limit)).map((video) => ({
    ...video,
    reviewAs: covers(scope, video.spot.cityId) ? ("curator" as const) : ("owner" as const),
  }));
  return { cityIds, items, videos };
}

async function cardDetails(db: Database, submissionIds: string[]) {
  const rows =
    submissionIds.length === 0
      ? []
      : await db
          .select({
            submissionId: submission.id,
            submitter: { id: user.id, name: user.name },
            spotCityId: spot.cityId,
            spotOwnerId: spot.createdBy,
            editable: isEditableSpot,
            values: { title: spot.title, description: spot.description, spotKind: spot.kind, obstacles: spot.obstacles, condition: spot.condition, location: spot.location },
            photoCount: sql<number>`(select count(*) from ${spotPhoto} where ${spotPhoto.spotId} = ${spot.id})`.mapWith(Number),
            removedPhotoCount: editRemovedPhotoCount,
          })
          .from(submission)
          .leftJoin(user, eq(user.id, submission.submittedBy))
          .leftJoin(spot, and(eq(spot.id, submission.spotId), eq(submission.kind, "edit_spot")))
          .where(inArray(submission.id, submissionIds));
  return new Map(
    rows.map(({ submissionId, editable, values, photoCount, removedPhotoCount, ...row }) => {
      const current: SpotSnapshot | null = editable === true && values !== null ? toSnapshot(values, photoCount, removedPhotoCount) : null;
      return [submissionId, { ...row, current }];
    }),
  );
}

const toSnapshot = ({ location, ...fields }: SpotValues, photoCount: number, removedPhotoCount: number): SpotSnapshot => ({
  ...fields,
  ...location,
  photoCount,
  removedPhotoCount,
});

async function lockForReview(tx: Database, scope: Scope, actorId: string, submissionId: string) {
  const [row] = await tx
    .select({
      spotOwnerId: sql<string | null>`case when ${submission.kind} = 'edit_spot' then ${spot.createdBy} end`,
      spotCityId: spot.cityId,
      isPrivate: isPrivateSubmission,
      kind: submission.kind,
      changedFields: submission.changedFields,
      basePhotoIds: submission.basePhotoIds,
      status: submission.status,
      cityId: submission.cityId,
      submittedBy: submission.submittedBy,
      spotId: submission.spotId,
      rejectReason: submission.rejectReason,
      reviewedBy: submission.reviewedBy,
      reviewedAt: submission.reviewedAt,
      updatedAt: submission.updatedAt,
      title: submission.title,
      description: submission.description,
      spotKind: submission.spotKind,
      obstacles: submission.obstacles,
      condition: submission.condition,
      location: submission.location,
    })
    .from(submission)
    .leftJoin(spot, eq(spot.id, submission.spotId))
    .where(eq(submission.id, submissionId))
    .for("update", { of: submission });
  if (!row) return err<never, AppError>({ code: "not_found", message: "No such submission" });
  const role = reviewerRole(scope, actorId, { ...row, fromCityId: row.kind === "edit_spot" ? row.spotCityId : undefined });
  if (role === undefined) return err<never, AppError>(outsideScope);
  return ok({ ...row, role });
}

async function reload(db: Database, submissionId: string): Promise<Result<Submission, AppError>> {
  const [saved] = await loadSubmissions(db, eq(submission.id, submissionId));
  return saved ? ok(saved) : err({ code: "internal_error", message: "The submission could not be read back" });
}

export async function approveSubmission(
  db: Database,
  actor: CurrentUser,
  submissionId: string,
  { edits, seenUpdatedAt, wholePhotoList }: { edits: SpotEdits; seenUpdatedAt: string; wholePhotoList?: true | undefined },
): Promise<Result<Submission, AppError>> {
  const scope = await reviewScope(db, actor);
  const decided = await inTransaction(db, (tx) => safeTry(async function* (): Attempt<void, AppError> {
    const row = yield* await lockForReview(tx, scope, actor.id, submissionId);
    if (row.isPrivate) return err(notReviewed);
    if (row.status === "approved" && row.reviewedBy === actor.id) return ok(undefined);
    yield* decidable("submission", row, seenUpdatedAt);

    // A spot's owner may move its pin anywhere.
    const checkPlace = async (place: { latitude: number; longitude: number }): Promise<Result<void, AppError>> => {
      if (row.role === "owner") return ok(undefined);
      const moved = await tx.execute<{ city_id: string | null }>(
        sql`select spot_city_for(ST_SetSRID(ST_MakePoint(${place.longitude}, ${place.latitude}), 4326)) as city_id`,
      );
      return covers(scope, moved.rows[0]?.city_id ?? null) ? ok(undefined) : err({ code: "forbidden", message: "The new pin is outside the cities you review" });
    };

    if (row.kind === "edit_spot") {
      yield* reviewableEdit(row, wholePhotoList === true);
      const { spotId, ...replaced } = yield* await applyEdit(tx, submissionId, row, edits, checkPlace);
      await tx
        .update(submission)
        .set({ status: "approved", reviewedBy: actor.id, reviewedAt: new Date(), rejectReason: null })
        .where(eq(submission.id, submissionId));
      await tx
        .insert(reviewEvent)
        .values({ submissionId, actorId: actor.id, action: "approve", details: { spotId, edits, ...replaced, as: row.role } });
      return ok(undefined);
    }

    const { spotKind, ...values } = withChanges(row, edits);
    if (values.location !== row.location) {
      yield* await checkPlace(values.location);
    }

    const published = pickPhotos(await submissionPhotoRows(tx, submissionId), edits.photoIds);
    if (published === undefined) return err({ code: "validation_failed", message: "Choose photos from this submission only" });

    const fields = {
      status: "published" as const,
      ...values,
      kind: spotKind,
      createdBy: row.submittedBy,
      approvedBy: actor.id,
      removalReason: null,
      removedAt: null,
    };
    let spotId = row.spotId;
    if (spotId === null) {
      const [created] = await tx.insert(spot).values({ id: sql`uuidv7()::text`, ...fields }).returning({ id: spot.id });
      spotId = created?.id ?? null;
    } else {
      await tx.update(spot).set(fields).where(eq(spot.id, spotId));
      await tx.delete(spotPhoto).where(eq(spotPhoto.spotId, spotId));
    }
    if (spotId === null) return err({ code: "internal_error", message: "The spot was not created" });
    const publishedSpotId = spotId;
    if (published.length > 0) {
      await tx.insert(spotPhoto).values(published.map((photo, position) => ({ ...uploadedPhoto(photo), id: sql`uuidv7()::text`, spotId: publishedSpotId, position })));
    }
    await tx
      .update(submission)
      .set({ status: "approved", spotId: publishedSpotId, reviewedBy: actor.id, reviewedAt: new Date(), rejectReason: null })
      .where(eq(submission.id, submissionId));
    await tx
      .insert(reviewEvent)
      .values({ submissionId, actorId: actor.id, action: "approve", details: { spotId: publishedSpotId, edits, as: row.role } });
    return ok(undefined);
  }));
  return decided.isErr() ? err(decided.error) : reload(db, submissionId);
}

export async function rejectSubmission(
  db: Database,
  actor: CurrentUser,
  submissionId: string,
  { reason, seenUpdatedAt }: { reason: RejectReason; seenUpdatedAt: string },
): Promise<Result<Submission, AppError>> {
  const scope = await reviewScope(db, actor);
  const decided = await inTransaction(db, (tx) => safeTry(async function* (): Attempt<void, AppError> {
    const row = yield* await lockForReview(tx, scope, actor.id, submissionId);
    if (row.isPrivate) return err(notReviewed);
    if (row.status === "rejected" && row.reviewedBy === actor.id && row.rejectReason === reason) return ok(undefined);
    yield* decidable("submission", row, seenUpdatedAt);
    await tx
      .update(submission)
      .set({ status: "rejected", rejectReason: reason, reviewedBy: actor.id, reviewedAt: new Date() })
      .where(eq(submission.id, submissionId));
    await tx.insert(reviewEvent).values({ submissionId, actorId: actor.id, action: "reject", details: { reason, as: row.role } });
    return ok(undefined);
  }));
  return decided.isErr() ? err(decided.error) : reload(db, submissionId);
}

export async function undoDecision(db: Database, actor: CurrentUser, submissionId: string): Promise<Result<Submission, AppError>> {
  const scope = await reviewScope(db, actor);
  const undone = await inTransaction(db, (tx) => safeTry(async function* (): Attempt<void, AppError> {
    const row = yield* await lockForReview(tx, scope, actor.id, submissionId);
    if (row.isPrivate) {
      // Never back to the queue, where curators outside its collection would see it: an admin's undo takes it down.
      if (actor.role !== "admin") return err(notReviewed);
      if (row.spotId !== null) await tx.update(spot).set({ status: "removed" }).where(eq(spot.id, row.spotId));
      await tx.insert(reviewEvent).values({ submissionId, actorId: actor.id, action: "undo", details: { from: row.status, private: true } });
      return ok(undefined);
    }
    if (row.status === "pending") return await repeatedUndo(tx, actor.id, eq(reviewEvent.submissionId, submissionId));
    yield* mayUndo(actor, row);
    if (row.status === "approved" && row.kind === "edit_spot") {
      yield* await revertEdit(tx, submissionId, row.spotId);
    } else if (row.status === "approved" && row.spotId !== null) {
      // The undone approval is why it's gone now, not an earlier takedown, so it isn't restorable and its history says pending.
      await tx.update(spot).set({ status: "removed", removalReason: null, removedAt: null }).where(eq(spot.id, row.spotId));
    }
    await tx
      .update(submission)
      .set({ status: "pending", reviewedBy: null, reviewedAt: null, rejectReason: null })
      .where(eq(submission.id, submissionId));
    await tx.insert(reviewEvent).values({ submissionId, actorId: actor.id, action: "undo", details: { from: row.status } });
    return ok(undefined);
  }));
  return undone.isErr() ? err(undone.error) : reload(db, submissionId);
}
