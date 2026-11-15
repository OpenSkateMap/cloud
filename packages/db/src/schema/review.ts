import { sql } from "drizzle-orm";
import { bigint, check, index, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { quoted } from "./checks.ts";
import { city, spot } from "./spots.ts";
import { submission } from "./submissions.ts";
import { spotVideo } from "./videos.ts";

export const REVIEW_ACTIONS = ["approve", "reject", "undo", "remove", "restore"] as const;

export const cityEditor = pgTable(
  "city_editor",
  {
    cityId: text("city_id")
      .notNull()
      .references(() => city.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    grantedBy: text("granted_by").references(() => user.id, { onDelete: "set null" }),
    grantedAt: timestamp("granted_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.cityId, table.userId] }), index("city_editor_user_idx").on(table.userId)],
);

export const reviewEvent = pgTable(
  "review_event",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    submissionId: text("submission_id").references(() => submission.id, { onDelete: "cascade" }),
    videoId: text("video_id").references(() => spotVideo.id, { onDelete: "cascade" }),
    spotId: text("spot_id").references(() => spot.id, { onDelete: "cascade" }),
    actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
    action: text("action", { enum: REVIEW_ACTIONS }).notNull(),
    details: jsonb("details").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Each row has exactly one subject, so each is indexed only where it's set.
    index("review_event_submission_idx").on(table.submissionId).where(sql`${table.submissionId} is not null`),
    index("review_event_video_idx").on(table.videoId).where(sql`${table.videoId} is not null`),
    index("review_event_spot_idx").on(table.spotId).where(sql`${table.spotId} is not null`),
    index("review_event_actor_idx").on(table.actorId),
    check("review_event_one_subject", sql`num_nonnulls(${table.submissionId}, ${table.videoId}, ${table.spotId}) = 1`),
    check("review_event_action_known", sql`${table.action} in (${sql.raw(quoted(REVIEW_ACTIONS))})`),
  ],
);
