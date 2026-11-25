import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { clipUpload } from "./clips.ts";
import { collection } from "./collections.ts";
import { point } from "./geo.ts";
import { osmPlace } from "./places.ts";
import { city, SPOT_CONDITIONS, SPOT_KINDS, spot } from "./spots.ts";

export const SUBMISSION_KINDS = ["new_spot", "edit_spot"] as const;
export const SPOT_EDIT_FIELDS = ["title", "description", "spotKind", "obstacles", "condition", "location", "photos"] as const;
export const SUBMISSION_STATUSES = ["pending", "approved", "rejected"] as const;
export const REJECT_REASONS = ["duplicate", "not_a_spot", "wrong_location", "private_property", "photo_rights"] as const;

const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

export const photoUpload = pgTable(
  "photo_upload",
  {
    id: text("id").primaryKey(),
    uploadedBy: text("uploaded_by").references(() => user.id, { onDelete: "set null" }),
    r2Key: text("r2_key").notNull(),
    bytes: integer("bytes").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("photo_upload_uploaded_by_idx").on(table.uploadedBy)],
);

export const submission = pgTable(
  "submission",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: SUBMISSION_KINDS }).notNull(),
    status: text("status", { enum: SUBMISSION_STATUSES }).notNull().default("pending"),
    submittedBy: text("submitted_by").references(() => user.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    spotKind: text("spot_kind", { enum: SPOT_KINDS }).notNull(),
    obstacles: text("obstacles").array().notNull().default(sql`'{}'::text[]`),
    condition: text("condition", { enum: SPOT_CONDITIONS }).notNull().default("skateable"),
    location: point("location").notNull(),
    cityId: text("city_id").references(() => city.id, { onDelete: "set null" }),
    note: text("note").notNull().default(""),
    spotId: text("spot_id").references(() => spot.id, { onDelete: "set null" }),
    changedFields: text("changed_fields", { enum: SPOT_EDIT_FIELDS }).array().notNull().default(sql`'{}'::text[]`),
    /** The spot's photo ids the edit started from; null for an edit sent without photoEdit. */
    basePhotoIds: text("base_photo_ids").array(),
    collectionId: text("collection_id").references(() => collection.id, { onDelete: "set null" }),
    rejectReason: text("reject_reason", { enum: REJECT_REASONS }),
    reviewedBy: text("reviewed_by").references(() => user.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("submission_submitted_by_idx").on(table.submittedBy, table.createdAt),
    index("submission_pending_city_idx")
      .on(table.cityId, table.createdAt)
      .where(sql`${table.status} = 'pending'`),
    // Foreign keys whose ON DELETE would otherwise scan the table when a collection or an account goes.
    index("submission_collection_idx").on(table.collectionId).where(sql`${table.collectionId} is not null`),
    index("submission_reviewed_by_idx").on(table.reviewedBy).where(sql`${table.reviewedBy} is not null`),
    check("submission_title_length", sql`char_length(${table.title}) between 1 and 120`),
    check("submission_description_length", sql`char_length(${table.description}) <= 2000`),
    check("submission_note_length", sql`char_length(${table.note}) <= 500`),
  ],
);

export const submissionPhoto = pgTable(
  "submission_photo",
  {
    submissionId: text("submission_id")
      .notNull()
      .references(() => submission.id, { onDelete: "cascade" }),
    photoId: text("photo_id").references(() => photoUpload.id, { onDelete: "cascade" }),
    // No foreign key: a photo an approval removed and its undo restored (same id) is kept again by edits still waiting.
    spotPhotoId: text("spot_photo_id"),
    position: integer("position").notNull(),
    thumbhash: text("thumbhash").notNull(),
    credit: text("credit"),
    hasPermission: boolean("has_permission").notNull(),
    sourceUrl: text("source_url"),
    clipId: text("clip_id").references(() => clipUpload.id, { onDelete: "set null" }),
  },
  (table) => [
    primaryKey({ columns: [table.submissionId, table.position] }),
    index("submission_photo_photo_idx").on(table.photoId),
    index("submission_photo_clip_idx").on(table.clipId).where(sql`${table.clipId} is not null`),
    check("submission_photo_rights", sql`${table.credit} is null or ${table.hasPermission}`),
    check("submission_photo_source", sql`(${table.photoId} is null) <> (${table.spotPhotoId} is null)`),
  ],
);

/** The place a pending public submission outside every city was found in; a row of its own, so the lookup never moves the submission's `updated_at`. */
export const submissionPlace = pgTable(
  "submission_place",
  {
    submissionId: text("submission_id")
      .primaryKey()
      .references(() => submission.id, { onDelete: "cascade" }),
    osmPlaceId: text("osm_place_id")
      .notNull()
      .references(() => osmPlace.id),
  },
  (table) => [index("submission_place_osm_place_idx").on(table.osmPlaceId)],
);
