import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";

export const appleToken = pgTable("apple_token", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  clientId: text("client_id").notNull(),
  refreshToken: text("refresh_token").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Apple said the Apple Account behind this one was deleted: ours goes at `dueAt`, unless they sign in again first. */
export const appleAccountDeletion = pgTable(
  "apple_account_deletion",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    noticedAt: timestamp("noticed_at", { withTimezone: true }).notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("apple_account_deletion_due_idx").on(table.dueAt)],
);
