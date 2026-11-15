import type { Database } from "@openskatemap/db";
import { reviewEvent, spot, spotVideo } from "@openskatemap/db/schema";
import { eq } from "drizzle-orm";
import type { CurrentUser } from "../env.ts";
import type { AppError } from "../lib/errors.ts";
import { type Attempt, err, ok, type Result, safeTry } from "../lib/result.ts";
import type { VideoRejectReason, VideoSubmission } from "../lib/video-schemas.ts";
import { decidable, mayUndo, repeatedUndo, reviewerRole, reviewScope, type Scope } from "./review.ts";
import { loadVideoSubmissions } from "./videos.ts";
import { inTransaction } from "../lib/transaction";

const outsideScope: AppError = { code: "forbidden", message: "You don't review this video" };

async function lockForReview(tx: Database, scope: Scope, actorId: string, videoId: string) {
  const [row] = await tx
    .select({
      status: spotVideo.status,
      rejectReason: spotVideo.rejectReason,
      reviewedBy: spotVideo.reviewedBy,
      reviewedAt: spotVideo.reviewedAt,
      updatedAt: spotVideo.updatedAt,
      cityId: spot.cityId,
      spotOwnerId: spot.createdBy,
      submittedBy: spotVideo.submittedBy,
    })
    .from(spotVideo)
    .innerJoin(spot, eq(spot.id, spotVideo.spotId))
    .where(eq(spotVideo.id, videoId))
    .for("update", { of: spotVideo });
  if (!row) return err<never, AppError>({ code: "not_found", message: "No such video" });
  const role = reviewerRole(scope, actorId, row);
  if (role === undefined) return err<never, AppError>(outsideScope);
  return ok({ ...row, role });
}

async function reload(db: Database, videoId: string): Promise<Result<VideoSubmission, AppError>> {
  const [saved] = await loadVideoSubmissions(db, eq(spotVideo.id, videoId));
  return saved ? ok(saved) : err({ code: "internal_error", message: "The video could not be read back" });
}

export async function approveVideo(db: Database, actor: CurrentUser, videoId: string, { seenUpdatedAt }: { seenUpdatedAt: string }) {
  const scope = await reviewScope(db, actor);
  const decided = await inTransaction(db, (tx) => safeTry(async function* (): Attempt<void, AppError> {
    const row = yield* await lockForReview(tx, scope, actor.id, videoId);
    if (row.status === "approved" && row.reviewedBy === actor.id) return ok(undefined);
    yield* decidable("video", row, seenUpdatedAt);
    await tx.update(spotVideo).set({ status: "approved", reviewedBy: actor.id, reviewedAt: new Date() }).where(eq(spotVideo.id, videoId));
    await tx.insert(reviewEvent).values({ videoId, actorId: actor.id, action: "approve", details: { as: row.role } });
    return ok(undefined);
  }));
  return decided.isErr() ? err(decided.error) : reload(db, videoId);
}

export async function rejectVideo(
  db: Database,
  actor: CurrentUser,
  videoId: string,
  { reason, seenUpdatedAt }: { reason: VideoRejectReason; seenUpdatedAt: string },
) {
  const scope = await reviewScope(db, actor);
  const decided = await inTransaction(db, (tx) => safeTry(async function* (): Attempt<void, AppError> {
    const row = yield* await lockForReview(tx, scope, actor.id, videoId);
    if (row.status === "rejected" && row.reviewedBy === actor.id && row.rejectReason === reason) return ok(undefined);
    yield* decidable("video", row, seenUpdatedAt);
    await tx
      .update(spotVideo)
      .set({ status: "rejected", rejectReason: reason, reviewedBy: actor.id, reviewedAt: new Date() })
      .where(eq(spotVideo.id, videoId));
    await tx.insert(reviewEvent).values({ videoId, actorId: actor.id, action: "reject", details: { reason, as: row.role } });
    return ok(undefined);
  }));
  return decided.isErr() ? err(decided.error) : reload(db, videoId);
}

export async function undoVideoDecision(db: Database, actor: CurrentUser, videoId: string) {
  const scope = await reviewScope(db, actor);
  const undone = await inTransaction(db, (tx) => safeTry(async function* (): Attempt<void, AppError> {
    const row = yield* await lockForReview(tx, scope, actor.id, videoId);
    if (row.status === "pending") return await repeatedUndo(tx, actor.id, eq(reviewEvent.videoId, videoId));
    yield* mayUndo(actor, row);
    await tx.update(spotVideo).set({ status: "pending", reviewedBy: null, reviewedAt: null, rejectReason: null }).where(eq(spotVideo.id, videoId));
    await tx.insert(reviewEvent).values({ videoId, actorId: actor.id, action: "undo", details: { from: row.status } });
    return ok(undefined);
  }));
  return undone.isErr() ? err(undone.error) : reload(db, videoId);
}
