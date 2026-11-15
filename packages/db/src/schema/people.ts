import { sql } from "drizzle-orm";
import { check, index, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { photoUpload } from "./submissions.ts";

export const REPORT_TARGETS = ["spot", "user", "video"] as const;
export const REPORT_REASONS = ["inappropriate", "spam", "wrong_info", "private_property", "photo_rights", "harassment", "other"] as const;
export const REPORT_STATUSES = ["open", "resolved"] as const;

export const profile = pgTable(
  "profile",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    username: text("username"),
    bio: text("bio").notNull().default(""),
    avatarPhotoId: text("avatar_photo_id").references(() => photoUpload.id, { onDelete: "set null" }),
    avatarThumbhash: text("avatar_thumbhash"),
    instagram: text("instagram"),
    tiktok: text("tiktok"),
    youtube: text("youtube"),
    x: text("x"),
    telegram: text("telegram"),
    website: text("website"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("profile_username_lower_unique").on(sql`lower(${table.username})`),
    index("profile_avatar_photo_idx").on(table.avatarPhotoId).where(sql`${table.avatarPhotoId} is not null`),
    check("profile_bio_length", sql`char_length(${table.bio}) <= 160`),
  ],
);

export const report = pgTable(
  "report",
  {
    id: text("id").primaryKey(),
    reporterId: text("reporter_id").references(() => user.id, { onDelete: "set null" }),
    targetKind: text("target_kind", { enum: REPORT_TARGETS }).notNull(),
    targetId: text("target_id").notNull(),
    reason: text("reason", { enum: REPORT_REASONS }).notNull(),
    message: text("message").notNull().default(""),
    status: text("status", { enum: REPORT_STATUSES }).notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("report_open_idx").on(table.createdAt).where(sql`${table.status} = 'open'`),
    check("report_message_length", sql`char_length(${table.message}) <= 500`),
  ],
);

export const userBlock = pgTable(
  "user_block",
  {
    blockerId: text("blocker_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    blockedId: text("blocked_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockerId, table.blockedId] }),
    index("user_block_blocked_idx").on(table.blockedId),
    check("user_block_not_self", sql`${table.blockerId} <> ${table.blockedId}`),
  ],
);
