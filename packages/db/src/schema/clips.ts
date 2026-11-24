import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";

export const CLIP_MAX_DURATION_MS = 16_000;

export const clipUpload = pgTable(
  "clip_upload",
  {
    id: text("id").primaryKey(),
    uploadedBy: text("uploaded_by").references(() => user.id, { onDelete: "set null" }),
    r2Key: text("r2_key").notNull(),
    bytes: integer("bytes").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    durationMs: integer("duration_ms").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("clip_upload_uploaded_by_idx").on(table.uploadedBy),
    check("clip_upload_duration", sql`${table.durationMs} between 1 and ${sql.raw(String(CLIP_MAX_DURATION_MS))}`),
  ],
);
