import type { Database } from "@openskatemap/db";
import { photoUpload, session } from "@openskatemap/db/schema";
import { and, inArray, lt } from "drizzle-orm";
import { logFailure } from "../lib/log.ts";
import { isUnusedUpload } from "./photos.ts";

const DAY_MS = 86_400_000;
const UNUSED_UPLOAD_DAYS = 7;
// R2 deletes at most 1,000 keys a call; more waits for the next day.
const UPLOAD_BATCH = 1000;

export interface Swept {
  readonly photoKeys: readonly string[];
  readonly sessions: number;
}

/** Deletes old uploads nothing uses and expired sessions; `deleteSweptPhotos` removes the photos from R2 once the connection is closed. */
export async function sweep(db: Database, now: Date): Promise<Swept> {
  const stale = db
    .select({ id: photoUpload.id })
    .from(photoUpload)
    .where(and(lt(photoUpload.createdAt, new Date(now.getTime() - UNUSED_UPLOAD_DAYS * DAY_MS)), isUnusedUpload))
    .limit(UPLOAD_BATCH);
  const photos = await db.delete(photoUpload).where(inArray(photoUpload.id, stale)).returning({ key: photoUpload.r2Key });
  const sessions = await db.delete(session).where(lt(session.expiresAt, now));
  return { photoKeys: photos.map((photo) => photo.key), sessions: sessions.rowCount ?? 0 };
}

export async function deleteSweptPhotos(bucket: R2Bucket, swept: Swept): Promise<void> {
  try {
    if (swept.photoKeys.length > 0) await bucket.delete([...swept.photoKeys]);
    console.log("Housekeeping", { unusedPhotos: swept.photoKeys.length, expiredSessions: swept.sessions });
  } catch (error) {
    logFailure("Deleting unused photos from R2 failed", error);
  }
}
