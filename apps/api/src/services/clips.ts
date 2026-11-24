import type { Database } from "@openskatemap/db";
import { clipUpload, spotPhoto, submissionPhoto } from "@openskatemap/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { AppError } from "../lib/errors.ts";
import { cleanMp4 } from "../lib/mp4.ts";
import { err, ok, type Result } from "../lib/result.ts";
import type { ClipUpload } from "../lib/submission-schemas.ts";
import type { UploadStore } from "./photos.ts";

type Row = typeof clipUpload.$inferSelect;

/** SQL: a clip no submission's photo and no spot's photo plays. */
export const isUnusedClip = sql<boolean>`(
  not exists (select 1 from ${submissionPhoto} where ${submissionPhoto.clipId} = ${clipUpload.id})
  and not exists (select 1 from ${spotPhoto} where ${spotPhoto.clipId} = ${clipUpload.id})
)`;

const toClip = (row: Row): ClipUpload => ({ id: row.id, width: row.width, height: row.height, durationMs: row.durationMs, bytes: row.bytes });

const owned = (row: Row, uploaderId: string): Result<ClipUpload, AppError> =>
  row.uploadedBy === uploaderId ? ok(toClip(row)) : err({ code: "forbidden", message: "This clip id belongs to someone else" });

export const CLIP_HTTP_METADATA = { contentType: "video/mp4", cacheControl: "public, max-age=31536000, immutable" } as const;

export async function saveClip(db: Database, bucket: UploadStore, uploaderId: string, clipId: string, body: Uint8Array): Promise<Result<ClipUpload, AppError>> {
  const [existing] = await db.select().from(clipUpload).where(eq(clipUpload.id, clipId));
  if (existing) return owned(existing, uploaderId);

  const clean = cleanMp4(body);
  if (clean.isErr()) return err({ code: "validation_failed", message: `Not a usable clip: ${clean.error}` });
  const { bytes, width, height, durationMs } = clean.value;
  const r2Key = `clips/${crypto.randomUUID()}.mp4`;
  await bucket.put(r2Key, bytes, { httpMetadata: CLIP_HTTP_METADATA });
  const [created] = await db
    .insert(clipUpload)
    .values({ id: clipId, uploadedBy: uploaderId, r2Key, bytes: bytes.length, width, height, durationMs })
    .onConflictDoNothing()
    .returning();
  if (created) return ok(toClip(created));

  await bucket.delete(r2Key);
  const [winner] = await db.select().from(clipUpload).where(eq(clipUpload.id, clipId));
  return winner ? owned(winner, uploaderId) : err({ code: "unavailable", message: "The upload raced another one; send it again" });
}

/** Only clips the account uploaded itself; the rest come back as `details.missingClips`. */
export async function requireClips(db: Database, uploaderId: string, clipIds: readonly string[]): Promise<Result<void, AppError>> {
  if (clipIds.length === 0) return ok(undefined);
  const uploaded = await db
    .select({ id: clipUpload.id })
    .from(clipUpload)
    .where(and(inArray(clipUpload.id, [...clipIds]), eq(clipUpload.uploadedBy, uploaderId)));
  const found = new Set(uploaded.map((row) => row.id));
  const missingClips = clipIds.filter((clipId) => !found.has(clipId));
  return missingClips.length > 0
    ? err({ code: "validation_failed", message: "Upload these clips first", details: { missingClips } })
    : ok(undefined);
}
