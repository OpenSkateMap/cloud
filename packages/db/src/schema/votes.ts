import { sql } from "drizzle-orm";
import { check, index, pgTable, primaryKey, smallint, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { spot } from "./spots.ts";

/** Votes never touch the spot row: they must not move its version, the sync cursor. */
export const spotVote = pgTable(
  "spot_vote",
  {
    spotId: text("spot_id")
      .notNull()
      .references(() => spot.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    value: smallint("value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.spotId, table.userId] }),
    index("spot_vote_user_idx").on(table.userId),
    check("spot_vote_value", sql`${table.value} in (-1, 1)`),
  ],
);
