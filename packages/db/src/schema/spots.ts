import { type SQL, sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, jsonb, pgSequence, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { quoted } from "./checks.ts";
import { clipUpload } from "./clips.ts";
import { multiPolygon, point } from "./geo.ts";
import { osmPlace } from "./places.ts";

const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

export const SPOT_KINDS = ["street", "park", "diy", "plaza"] as const;
export const SPOT_CONDITIONS = ["skateable", "knobbed", "demolished", "busty"] as const;
export const SPOT_STATUSES = ["published", "removed"] as const;
export const SPOT_VISIBILITIES = ["public", "private"] as const;
export const SPOT_REMOVAL_REASONS = ["duplicate", "private_property", "unsafe_or_gone", "not_a_spot", "other"] as const;

/** The apps' languages; a city's `names` has one entry for each, or none before its names were filled. */
export const CITY_LANGUAGES = ["ar", "de", "en", "es", "fr", "hi", "it", "ja", "pl", "pt", "ru", "tr", "uk", "zh-Hans", "zh-Hant"] as const;
export type CityLanguage = (typeof CITY_LANGUAGES)[number];
export type CityNames = Partial<Record<CityLanguage, string>>;

/** The sync cursor: migration 0003's trigger assigns it under an advisory lock, so versions follow commit order. */
export const spotVersion = pgSequence("spot_version_seq", { startWith: 1 });

export const city = pgTable(
  "city",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    /** English; what every language without its own name shows. */
    name: text("name").notNull(),
    names: jsonb("names").$type<CityNames>().notNull().default({}),
    /** The Wikidata item the names come from. */
    wikidataId: text("wikidata_id"),
    /** The OpenStreetMap place a city made by a lookup came from; null for a hand-drawn one. */
    osmPlaceId: text("osm_place_id")
      .unique()
      .references(() => osmPlace.id),
    countryCode: text("country_code").notNull(),
    area: multiPolygon("area").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("city_area_gist").using("gist", table.area),
    check("city_names_object", sql`jsonb_typeof(${table.names}) = 'object'`),
    check("city_wikidata_id_format", sql`${table.wikidataId} ~ '^Q[1-9][0-9]*$'`),
  ],
);

export const spot = pgTable(
  "spot",
  {
    id: text("id").primaryKey(),
    status: text("status", { enum: SPOT_STATUSES }).notNull().default("published"),
    /** Private spots never enter public sync, nearby, share cards, votes or videos (`docs/collections.md`). */
    visibility: text("visibility", { enum: SPOT_VISIBILITIES }).notNull().default("public"),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    location: point("location").notNull(),
    cityId: text("city_id").references(() => city.id, { onDelete: "set null" }),
    kind: text("kind", { enum: SPOT_KINDS }).notNull(),
    obstacles: text("obstacles").array().notNull().default(sql`'{}'::text[]`),
    condition: text("condition", { enum: SPOT_CONDITIONS }).notNull().default("skateable"),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    approvedBy: text("approved_by").references(() => user.id, { onDelete: "set null" }),
    /** Set only by an admin's takedown; an undone approval removes a spot without one. */
    removalReason: text("removal_reason", { enum: SPOT_REMOVAL_REASONS }),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    version: bigint("version", { mode: "number" }).notNull().default(0),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    /** What search matches the title by (`search_words()`, migration 0033). */
    searchText: text("search_text")
      .notNull()
      .generatedAlwaysAs((): SQL => sql`search_words(${spot.title})`),
  },
  (table) => [
    // Distances use `::geography` on both sides, so this is the only location index.
    index("spot_location_geography_gist").using("gist", sql`(${table.location}::geography)`),
    index("spot_version_idx").on(table.version),
    index("spot_created_by_idx").on(table.createdBy),
    index("spot_search_trgm").using("gin", table.searchText.op("gin_trgm_ops")),
    index("spot_city_idx").on(table.cityId),
    check("spot_title_length", sql`char_length(${table.title}) between 1 and 120`),
    check("spot_description_length", sql`char_length(${table.description}) <= 2000`),
    check("spot_visibility_known", sql`${table.visibility} in ('public', 'private')`),
    check("spot_removal_reason_known", sql`${table.removalReason} in (${sql.raw(quoted(SPOT_REMOVAL_REASONS))})`),
    check(
      "spot_removal_shape",
      sql`(${table.removalReason} is null) = (${table.removedAt} is null) and (${table.removalReason} is null or ${table.status} = 'removed')`,
    ),
    index("spot_private_idx").on(table.createdBy).where(sql`${table.visibility} = 'private'`),
  ],
);

export const spotPhoto = pgTable(
  "spot_photo",
  {
    id: text("id").primaryKey(),
    spotId: text("spot_id")
      .notNull()
      .references(() => spot.id, { onDelete: "cascade" }),
    r2Key: text("r2_key").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    thumbhash: text("thumbhash").notNull(),
    credit: text("credit"),
    hasPermission: boolean("has_permission").notNull(),
    sourceUrl: text("source_url"),
    uploadedBy: text("uploaded_by").references(() => user.id, { onDelete: "set null" }),
    position: integer("position").notNull(),
    createdAt: createdAt(),
    clipId: text("clip_id").references(() => clipUpload.id, { onDelete: "set null" }),
  },
  (table) => [
    uniqueIndex("spot_photo_spot_position").on(table.spotId, table.position),
    index("spot_photo_clip_idx").on(table.clipId).where(sql`${table.clipId} is not null`),
    check("spot_photo_rights", sql`${table.credit} is null or ${table.hasPermission}`),
  ],
);
