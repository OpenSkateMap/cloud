import type { Database } from "@openskatemap/db";
import { clipUpload, photoUpload, session } from "@openskatemap/db/schema";
import { and, inArray, lt } from "drizzle-orm";
import { logFailure } from "../lib/log.ts";
import { isUnusedClip } from "./clips.ts";
import { isUnusedUpload } from "./photos.ts";

const DAY_MS = 86_400_000;
const UNUSED_UPLOAD_DAYS = 7;
// R2 deletes at most 1,000 keys a call; more waits for the next day.
const UPLOAD_BATCH = 1000;

export interface Swept {
  readonly photoKeys: readonly string[];
  readonly clipKeys: readonly string[];
  readonly sessions: number;
}

/** Deletes old uploads nothing uses and expired sessions; `deleteSweptUploads` removes their files from R2 once the connection is closed. */
export async function sweep(db: Database, now: Date): Promise<Swept> {
  const before = new Date(now.getTime() - UNUSED_UPLOAD_DAYS * DAY_MS);
  const stalePhotos = db
    .select({ id: photoUpload.id })
    .from(photoUpload)
    .where(and(lt(photoUpload.createdAt, before), isUnusedUpload))
    .limit(UPLOAD_BATCH);
  const photos = await db.delete(photoUpload).where(inArray(photoUpload.id, stalePhotos)).returning({ key: photoUpload.r2Key });
  const clipBudget = UPLOAD_BATCH - photos.length;
  const staleClips = db
    .select({ id: clipUpload.id })
    .from(clipUpload)
    .where(and(lt(clipUpload.createdAt, before), isUnusedClip))
    .limit(clipBudget);
  // Photos and clips share one R2 delete call a day.
  const clips = clipBudget > 0 ? await db.delete(clipUpload).where(inArray(clipUpload.id, staleClips)).returning({ key: clipUpload.r2Key }) : [];
  const sessions = await db.delete(session).where(lt(session.expiresAt, now));
  return { photoKeys: photos.map((photo) => photo.key), clipKeys: clips.map((clip) => clip.key), sessions: sessions.rowCount ?? 0 };
}

export async function deleteSweptUploads(bucket: R2Bucket, swept: Swept): Promise<void> {
  try {
    const keys = [...swept.photoKeys, ...swept.clipKeys];
    if (keys.length > 0) await bucket.delete(keys);
    console.log("Housekeeping", { unusedPhotos: swept.photoKeys.length, unusedClips: swept.clipKeys.length, expiredSessions: swept.sessions });
  } catch (error) {
    logFailure("Deleting unused uploads from R2 failed", error);
  }
}
