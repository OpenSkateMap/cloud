import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { spot } from "./spots.ts";

export const VIDEO_PROVIDERS = ["youtube", "instagram"] as const;
export const VIDEO_STATUSES = ["pending", "approved", "rejected"] as const;
export const VIDEO_REJECT_REASONS = ["duplicate", "wrong_spot", "not_skating", "inappropriate"] as const;

export const spotVideo = pgTable(
  "spot_video",
  {
    id: text("id").primaryKey(),
    spotId: text("spot_id")
      .notNull()
      .references(() => spot.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: VIDEO_PROVIDERS }).notNull(),
    externalId: text("external_id").notNull(),
    url: text("url").notNull(),
    startSeconds: integer("start_seconds"),
    caption: text("caption").notNull().default(""),
    status: text("status", { enum: VIDEO_STATUSES }).notNull().default("pending"),
    submittedBy: text("submitted_by").references(() => user.id, { onDelete: "set null" }),
    rejectReason: text("reject_reason", { enum: VIDEO_REJECT_REASONS }),
    reviewedBy: text("reviewed_by").references(() => user.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("spot_video_approved_idx")
      .on(table.spotId, table.createdAt)
      .where(sql`${table.status} = 'approved'`),
    index("spot_video_pending_idx")
      .on(table.createdAt)
      .where(sql`${table.status} = 'pending'`),
    uniqueIndex("spot_video_clip_unique")
      .on(table.spotId, table.provider, table.externalId)
      .where(sql`${table.status} <> 'rejected'`),
    check("spot_video_caption_length", sql`char_length(${table.caption}) <= 120`),
  ],
);
