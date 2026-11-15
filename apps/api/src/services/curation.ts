import type { Database } from "@openskatemap/db";
import { reviewEvent, spot } from "@openskatemap/db/schema";
import { eq } from "drizzle-orm";
import type { CurrentUser } from "../env.ts";
import type { AppError } from "../lib/errors.ts";
import { err, ok, type Result } from "../lib/result.ts";
import type { SpotRemoval, SpotRemovalReason } from "../lib/spot-schemas.ts";
import { inTransaction } from "../lib/transaction";

/** `eventId` is the review event this request wrote; undefined when nothing changed. */
type Changed<T> = T & { eventId: number | undefined; isPrivate: boolean };

const notFound: AppError = { code: "not_found", message: "No such spot" };

async function lockSpot(tx: Database, spotId: string) {
  const [target] = await tx
    .select({ status: spot.status, visibility: spot.visibility, removalReason: spot.removalReason, removedAt: spot.removedAt })
    .from(spot)
    .where(eq(spot.id, spotId))
    .for("update");
  return target;
}

/** An admin's takedown: marked removed, never deleted, with the reason its submitter sees. Repeating it changes nothing. */
export async function takeDownSpot(
  db: Database,
  actor: CurrentUser,
  spotId: string,
  reason: SpotRemovalReason,
): Promise<Result<Changed<{ removal: SpotRemoval }>, AppError>> {
  return inTransaction(db, async (tx): Promise<Result<Changed<{ removal: SpotRemoval }>, AppError>> => {
    const target = await lockSpot(tx, spotId);
    // A spot removed without a reason is an undone approval: not on the map, nothing to take down.
    if (!target || (target.status === "removed" && target.removalReason === null)) return err(notFound);
    const isPrivate = target.visibility === "private";
    if (target.removalReason !== null && target.removedAt !== null) {
      return ok({ removal: { reason: target.removalReason, removedAt: target.removedAt.toISOString() }, eventId: undefined, isPrivate });
    }
    const removedAt = new Date();
    await tx.update(spot).set({ status: "removed", removalReason: reason, removedAt }).where(eq(spot.id, spotId));
    const [event] = await tx
      .insert(reviewEvent)
      .values({ spotId, actorId: actor.id, action: "remove", details: { reason, visibility: target.visibility } })
      .returning({ id: reviewEvent.id });
    return ok({ removal: { reason, removedAt: removedAt.toISOString() }, eventId: event?.id, isPrivate });
  });
}

/** Undoes a takedown: published again under a new version, so apps sync it back. Restoring a published spot changes nothing. */
export async function restoreSpot(db: Database, actor: CurrentUser, spotId: string): Promise<Result<Changed<object>, AppError>> {
  return inTransaction(db, async (tx): Promise<Result<Changed<object>, AppError>> => {
    const target = await lockSpot(tx, spotId);
    if (!target) return err(notFound);
    const isPrivate = target.visibility === "private";
    if (target.removalReason === null) {
      return target.status === "published"
        ? ok({ eventId: undefined, isPrivate })
        : err({ code: "conflict", message: "Only a spot an admin took down can be restored" });
    }
    await tx.update(spot).set({ status: "published", removalReason: null, removedAt: null }).where(eq(spot.id, spotId));
    const [event] = await tx
      .insert(reviewEvent)
      .values({ spotId, actorId: actor.id, action: "restore", details: { reason: target.removalReason } })
      .returning({ id: reviewEvent.id });
    return ok({ eventId: event?.id, isPrivate });
  });
}
