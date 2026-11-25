import type { Database } from "@openskatemap/db";
import { collection, photoUpload, profile, submissionPhoto } from "@openskatemap/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { AppError } from "../lib/errors.ts";
import { cleanJpeg } from "../lib/jpeg.ts";
import { err, ok, type Result } from "../lib/result.ts";
import type { PhotoUpload } from "../lib/submission-schemas.ts";

type Row = typeof photoUpload.$inferSelect;

/** SQL: an upload nothing uses: in no submission, no collection's photo, nobody's avatar. */
export const isUnusedUpload = sql<boolean>`(
  not exists (select 1 from ${submissionPhoto} where ${submissionPhoto.photoId} = ${photoUpload.id})
  and not exists (select 1 from ${collection} where ${collection.photoId} = ${photoUpload.id})
  and not exists (select 1 from ${profile} where ${profile.avatarPhotoId} = ${photoUpload.id})
)`;

const toPhoto = (row: Row): PhotoUpload => ({ id: row.id, width: row.width, height: row.height, bytes: row.bytes });

const owned = (row: Row, uploaderId: string): Result<PhotoUpload, AppError> =>
  row.uploadedBy === uploaderId ? ok(toPhoto(row)) : err({ code: "forbidden", message: "This photo id belongs to someone else" });

export const PHOTO_HTTP_METADATA = { contentType: "image/jpeg", cacheControl: "public, max-age=31536000, immutable" } as const;

export type UploadStore = {
  put(key: string, value: Uint8Array, options: { httpMetadata: { contentType: string; cacheControl: string } }): Promise<unknown>;
  delete(key: string): Promise<unknown>;
};

export async function savePhoto(db: Database, bucket: UploadStore, uploaderId: string, photoId: string, body: Uint8Array): Promise<Result<PhotoUpload, AppError>> {
  const [existing] = await db.select().from(photoUpload).where(eq(photoUpload.id, photoId));
  if (existing) return owned(existing, uploaderId);

  const clean = cleanJpeg(body);
  if (clean.isErr()) return err({ code: "validation_failed", message: `Not a usable photo: ${clean.error}` });
  const { bytes, width, height } = clean.value;
  const r2Key = `photos/${crypto.randomUUID()}.jpg`;
  await bucket.put(r2Key, bytes, { httpMetadata: PHOTO_HTTP_METADATA });
  const [created] = await db
    .insert(photoUpload)
    .values({ id: photoId, uploadedBy: uploaderId, r2Key, bytes: bytes.length, width, height })
    .onConflictDoNothing()
    .returning();
  if (created) return ok(toPhoto(created));

  await bucket.delete(r2Key);
  const [winner] = await db.select().from(photoUpload).where(eq(photoUpload.id, photoId));
  return winner ? owned(winner, uploaderId) : err({ code: "unavailable", message: "The upload raced another one; send it again" });
}

/** Only photos the account uploaded itself; the rest come back as `details.missingPhotos`. */
export async function requireUploads(db: Database, uploaderId: string, photoIds: readonly string[]): Promise<Result<void, AppError>> {
  if (photoIds.length === 0) return ok(undefined);
  const uploaded = await db
    .select({ id: photoUpload.id })
    .from(photoUpload)
    .where(and(inArray(photoUpload.id, [...photoIds]), eq(photoUpload.uploadedBy, uploaderId)));
  const found = new Set(uploaded.map((row) => row.id));
  const missingPhotos = photoIds.filter((photoId) => !found.has(photoId));
  return missingPhotos.length > 0
    ? err({ code: "validation_failed", message: "Upload these photos first", details: { missingPhotos } })
    : ok(undefined);
}
