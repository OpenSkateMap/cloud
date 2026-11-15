import type { Database } from "@openskatemap/db";
import { account, appleAccountDeletion, appleToken, session } from "@openskatemap/db/schema";
import { and, eq, gte, lt, lte } from "drizzle-orm";
import { logFailure } from "../lib/log.ts";
import type { AppleAccountEvent } from "../auth/apple-notifications.ts";
import { deleteAccount } from "./account.ts";

export type AppleEventOutcome = "signed-out" | "deletion-scheduled" | "ignored" | "unknown-account";

export const APPLE_ACCOUNT_GRACE_DAYS = 30;
const DUE_BATCH = 50;

/**
 * Stopping Sign in with Apple for the app, or deleting the Apple Account, ends every session that existed then.
 * Only those: a notice Apple delivers late or again never signs out a sign-in that came after it. A deleted Apple
 * Account also schedules ours for deletion, unless someone signed in since.
 */
export async function applyAppleAccountEvent(db: Database, event: AppleAccountEvent): Promise<AppleEventOutcome> {
  if (event.type !== "consent-revoked" && event.type !== "account-delete" && event.type !== "account-deleted") return "ignored";
  const [linked] = await db
    .select({ userId: account.userId })
    .from(account)
    .where(and(eq(account.providerId, "apple"), eq(account.accountId, event.appleUserId)));
  if (!linked) return "unknown-account";
  const { userId } = linked;
  return db.transaction(async (tx): Promise<AppleEventOutcome> => {
    await tx.delete(session).where(and(eq(session.userId, userId), lt(session.createdAt, event.at)));
    // Apple has already invalidated it; a newer one belongs to a later sign-in.
    await tx.delete(appleToken).where(and(eq(appleToken.userId, userId), lt(appleToken.updatedAt, event.at)));
    if (event.type === "consent-revoked") return "signed-out";
    const [signedInSince] = await tx
      .select({ id: session.id })
      .from(session)
      .where(and(eq(session.userId, userId), gte(session.createdAt, event.at)))
      .limit(1);
    if (signedInSince) return "signed-out";
    const dueAt = new Date(event.at.getTime() + APPLE_ACCOUNT_GRACE_DAYS * 86_400_000);
    await tx.insert(appleAccountDeletion).values({ userId, noticedAt: event.at, dueAt }).onConflictDoNothing();
    return "deletion-scheduled";
  });
}

export async function cancelAppleAccountDeletion(db: Database, userId: string): Promise<void> {
  await db.delete(appleAccountDeletion).where(eq(appleAccountDeletion.userId, userId));
}

/**
 * Deletes the accounts whose grace period ended, as Delete Account does (Apple dropped the token already, so there is
 * nothing to revoke); returns the ids it deleted, for the erasure elsewhere. One failing account doesn't hold up the rest.
 */
export async function deleteDueAccounts(db: Database, bucket: Pick<R2Bucket, "delete">, now: Date): Promise<string[]> {
  const due = await db
    .select({ userId: appleAccountDeletion.userId })
    .from(appleAccountDeletion)
    .where(lte(appleAccountDeletion.dueAt, now))
    .orderBy(appleAccountDeletion.dueAt)
    .limit(DUE_BATCH);
  const deleted: string[] = [];
  for (const { userId } of due) {
    try {
      if (await deleteAccount(db, bucket, userId, { stillWanted: (tx) => isStillDue(tx, userId, now) })) deleted.push(userId);
    } catch (error) {
      logFailure("Deleting an account whose Apple Account was deleted failed", error);
    }
  }
  return deleted;
}

/** Locks the schedule, so a sign-in cancelling it waits for this deletion or wins before it. */
async function isStillDue(tx: Database, userId: string, now: Date): Promise<boolean> {
  const [scheduled] = await tx
    .select({ noticedAt: appleAccountDeletion.noticedAt })
    .from(appleAccountDeletion)
    .where(and(eq(appleAccountDeletion.userId, userId), lte(appleAccountDeletion.dueAt, now)))
    .for("update");
  if (!scheduled) return false;
  const [signedInSince] = await tx
    .select({ id: session.id })
    .from(session)
    .where(and(eq(session.userId, userId), gte(session.createdAt, scheduled.noticedAt)))
    .limit(1);
  return signedInSince === undefined;
}
