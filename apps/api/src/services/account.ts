import type { Database } from "@openskatemap/db";
import { clipUpload, collection, photoUpload, profile, user } from "@openskatemap/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import type { AppleTokenSettings } from "../lib/auth-settings.ts";
import { parsePushSettings, removePushSubscriber } from "../lib/buzzkit.ts";
import { logFailure } from "../lib/log.ts";
import { deletePerson, parsePersonsSettings } from "../lib/posthog.ts";
import { revokeAppleToken } from "./apple-tokens.ts";
import { isUnusedClip } from "./clips.ts";
import { isUnusedUpload } from "./photos.ts";

// App Review requires revoking Sign in with Apple tokens when an account is deleted.
/** `stillWanted` runs first inside the deletion's transaction: false leaves the account as it is (and returns false). */
export async function deleteAccount(
  db: Database,
  bucket: Pick<R2Bucket, "delete">,
  userId: string,
  { apple, stillWanted }: { apple?: AppleTokenSettings | undefined; stillWanted?: (tx: Database) => Promise<boolean> } = {},
): Promise<boolean> {
  if (apple) {
    const revoked = await revokeAppleToken(db, apple, userId);
    if (revoked.isErr()) console.error("Apple token revocation failed", { reason: revoked.error });
  }
  const unusedKeys = await db.transaction(async (tx) => {
    if (stillWanted && !(await stillWanted(tx))) return undefined;
    // The account's collections and profile go first, so their photos count as unused (they'd go with it anyway).
    await tx.delete(collection).where(eq(collection.ownerId, userId));
    await tx.delete(profile).where(eq(profile.userId, userId));
    const unused = await tx
      .select({ id: photoUpload.id, r2Key: photoUpload.r2Key })
      .from(photoUpload)
      .where(and(eq(photoUpload.uploadedBy, userId), isUnusedUpload));
    if (unused.length > 0) await tx.delete(photoUpload).where(inArray(photoUpload.id, unused.map((photo) => photo.id)));
    const unusedClips = await tx
      .select({ id: clipUpload.id, r2Key: clipUpload.r2Key })
      .from(clipUpload)
      .where(and(eq(clipUpload.uploadedBy, userId), isUnusedClip));
    if (unusedClips.length > 0) await tx.delete(clipUpload).where(inArray(clipUpload.id, unusedClips.map((clip) => clip.id)));
    await tx.delete(user).where(eq(user.id, userId));
    return [...unused, ...unusedClips].map((upload) => upload.r2Key);
  });
  if (unusedKeys === undefined) return false;
  if (unusedKeys.length > 0) {
    try {
      await bucket.delete(unusedKeys);
    } catch (error) {
      logFailure("Deleting a deleted account's unused uploads failed", error);
    }
  }
  return true;
}

/** The rest of an account's erasure, outside our database: its push subscriber and its analytics person. */
export function eraseElsewhere(env: Env, userId: string): Promise<void>[] {
  const push = parsePushSettings(env);
  const persons = parsePersonsSettings(env);
  return [...(push ? [removePushSubscriber(push, userId)] : []), ...(persons ? [deletePerson(persons, userId)] : [])];
}
