import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { quoted } from "./checks.ts";
import { multiPolygon } from "./geo.ts";
import type { CityNames } from "./spots.ts";

export const PLACE_MISS_REASONS = ["no_city", "outside_place"] as const;

/** OpenStreetMap places a submission was found in, kept so Nominatim is asked about each place once; cities are made from them on approval. */
export const osmPlace = pgTable(
  "osm_place",
  {
    /** OpenStreetMap's own `<type>/<id>`, as in `relation/404159`. */
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    names: jsonb("names").$type<CityNames>().notNull().default({}),
    wikidataId: text("wikidata_id"),
    /** Before deduping against the cities' slugs. */
    slug: text("slug").notNull(),
    countryCode: text("country_code").notNull(),
    /** Nominatim's `addresstype`: city, town, municipality, or a regency-level one. */
    addressType: text("address_type").notNull(),
    area: multiPolygon("area").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("osm_place_area_gist").using("gist", table.area),
    check("osm_place_id_format", sql`${table.id} ~ '^(node|way|relation)/[1-9][0-9]*$'`),
    check("osm_place_names_object", sql`jsonb_typeof(${table.names}) = 'object'`),
    check("osm_place_wikidata_id_format", sql`${table.wikidataId} ~ '^Q[1-9][0-9]*$'`),
  ],
);

/** A grid cell (0.01°, about a kilometre) where a lookup found no place for a city, so it isn't asked again until `expires_at`. */
export const placeMiss = pgTable(
  "place_miss",
  {
    /** `<floor(latitude × 100)>:<floor(longitude × 100)>`. */
    cell: text("cell").primaryKey(),
    reason: text("reason", { enum: PLACE_MISS_REASONS }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [check("place_miss_reason_known", sql`${table.reason} in (${sql.raw(quoted(PLACE_MISS_REASONS))})`)],
);

/** Who may call a lookup service now: one caller at a time across every Worker, and a second apart (OpenStreetMap's usage policy). */
export const lookupLease = pgTable("lookup_lease", {
  service: text("service").primaryKey(),
  until: timestamp("until", { withTimezone: true }).notNull(),
});
