import { sql } from "drizzle-orm";
import { check, index, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { photoUpload } from "./submissions.ts";
import { spot } from "./spots.ts";
import { quoted } from "./checks.ts";

export const COLLECTION_VISIBILITIES = ["private", "public"] as const;
// favorites: the one every account has, starred spots; it can't be renamed or deleted.
export const COLLECTION_KINDS = ["custom", "favorites"] as const;

// Eight solid colours, then eight two-tone ones.
export const COLLECTION_COLORS = [
  "blue",
  "green",
  "orange",
  "red",
  "purple",
  "teal",
  "pink",
  "gray",
  "sky",
  "lime",
  "amber",
  "coral",
  "violet",
  "mint",
  "rose",
  "silver",
] as const;
// The apps map each to a symbol.
export const COLLECTION_PATTERNS = [
  "skateboard",
  "skater",
  "flame",
  "bolt",
  "star",
  "heart",
  "night",
  "sun",
  "camera",
  "video",
  "stairs",
  "cone",
  "road",
  "waves",
  "sparkles",
  "crown",
] as const;
// The owner is above all three and never a member row.
export const COLLECTION_ROLES = ["viewer", "editor", "admin"] as const;

const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

export const collection = pgTable(
  "collection",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    visibility: text("visibility", { enum: COLLECTION_VISIBILITIES }).notNull().default("private"),
    kind: text("kind", { enum: COLLECTION_KINDS }).notNull().default("custom"),
    color: text("color", { enum: COLLECTION_COLORS }),
    pattern: text("pattern", { enum: COLLECTION_PATTERNS }),
    photoId: text("photo_id").references(() => photoUpload.id, { onDelete: "set null" }),
    photoThumbhash: text("photo_thumbhash"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("collection_owner_idx").on(table.ownerId, table.createdAt),
    index("collection_photo_idx").on(table.photoId).where(sql`${table.photoId} is not null`),
    check("collection_name_length", sql`char_length(${table.name}) between 1 and 60`),
    check("collection_description_length", sql`char_length(${table.description}) <= 300`),
    check("collection_visibility_known", sql`${table.visibility} in ('private', 'public')`),
    check("collection_color_known", sql`${table.color} in (${sql.raw(quoted(COLLECTION_COLORS))})`),
    check("collection_pattern_known", sql`${table.pattern} in (${sql.raw(quoted(COLLECTION_PATTERNS))})`),
    check("collection_kind_known", sql`${table.kind} in (${sql.raw(quoted(COLLECTION_KINDS))})`),
    uniqueIndex("collection_favorites_unique").on(table.ownerId).where(sql`${table.kind} = 'favorites'`),
    check("collection_photo_thumbhash", sql`(${table.photoId} is null) = (${table.photoThumbhash} is null)`),
  ],
);

export const collectionSpot = pgTable(
  "collection_spot",
  {
    collectionId: text("collection_id")
      .notNull()
      .references(() => collection.id, { onDelete: "cascade" }),
    spotId: text("spot_id")
      .notNull()
      .references(() => spot.id, { onDelete: "cascade" }),
    addedBy: text("added_by").references(() => user.id, { onDelete: "set null" }),
    addedAt: timestamp("added_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.collectionId, table.spotId] }),
    index("collection_spot_spot_idx").on(table.spotId),
    index("collection_spot_page_idx").on(table.collectionId, table.addedAt, table.spotId),
    index("collection_spot_added_by_idx").on(table.addedBy).where(sql`${table.addedBy} is not null`),
  ],
);

export const collectionMember = pgTable(
  "collection_member",
  {
    collectionId: text("collection_id")
      .notNull()
      .references(() => collection.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role", { enum: COLLECTION_ROLES }).notNull().default("viewer"),
    addedAt: timestamp("added_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.collectionId, table.userId] }),
    index("collection_member_user_idx").on(table.userId),
    check("collection_member_role_known", sql`${table.role} in ('viewer', 'editor', 'admin')`),
  ],
);

export const collectionInvite = pgTable(
  "collection_invite",
  {
    id: text("id").primaryKey(),
    collectionId: text("collection_id")
      .notNull()
      .references(() => collection.id, { onDelete: "cascade" }),
    // Email invites get `user_id` when that account loads its collections; @username ones have it from the start.
    emailHash: text("email_hash"),
    email: text("email"),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    role: text("role", { enum: COLLECTION_ROLES }).notNull().default("viewer"),
    invitedBy: text("invited_by").references(() => user.id, { onDelete: "set null" }),
    // Declined, or reached someone already in: gone for them, still pending to the inviter like an unused address.
    declinedAt: timestamp("declined_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("collection_invite_email_unique").on(table.collectionId, table.emailHash),
    uniqueIndex("collection_invite_user_unique").on(table.collectionId, table.userId),
    index("collection_invite_email_idx").on(table.emailHash),
    index("collection_invite_user_idx").on(table.userId),
    index("collection_invite_invited_by_idx").on(table.invitedBy).where(sql`${table.invitedBy} is not null`),
    check("collection_invite_addressed", sql`${table.emailHash} is not null or ${table.userId} is not null`),
    check("collection_invite_role_known", sql`${table.role} in ('viewer', 'editor', 'admin')`),
  ],
);

export const collectionRequest = pgTable(
  "collection_request",
  {
    collectionId: text("collection_id")
      .notNull()
      .references(() => collection.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.collectionId, table.userId] }), index("collection_request_user_idx").on(table.userId)],
);
