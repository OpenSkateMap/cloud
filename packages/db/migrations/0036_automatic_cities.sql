CREATE TABLE "lookup_lease" (
	"service" text PRIMARY KEY NOT NULL,
	"until" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "osm_place" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"names" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"wikidata_id" text,
	"slug" text NOT NULL,
	"country_code" text NOT NULL,
	"address_type" text NOT NULL,
	"area" geometry(MultiPolygon, 4326) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "osm_place_id_format" CHECK ("osm_place"."id" ~ '^(node|way|relation)/[1-9][0-9]*$'),
	CONSTRAINT "osm_place_names_object" CHECK (jsonb_typeof("osm_place"."names") = 'object'),
	CONSTRAINT "osm_place_wikidata_id_format" CHECK ("osm_place"."wikidata_id" ~ '^Q[1-9][0-9]*$')
);
--> statement-breakpoint
CREATE TABLE "place_miss" (
	"cell" text PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "place_miss_reason_known" CHECK ("place_miss"."reason" in ('no_city', 'outside_place'))
);
--> statement-breakpoint
CREATE TABLE "submission_place" (
	"submission_id" text PRIMARY KEY NOT NULL,
	"osm_place_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "city" ADD COLUMN "osm_place_id" text;--> statement-breakpoint
ALTER TABLE "submission_place" ADD CONSTRAINT "submission_place_submission_id_submission_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submission"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_place" ADD CONSTRAINT "submission_place_osm_place_id_osm_place_id_fk" FOREIGN KEY ("osm_place_id") REFERENCES "public"."osm_place"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "osm_place_area_gist" ON "osm_place" USING gist ("area");--> statement-breakpoint
CREATE INDEX "submission_place_osm_place_idx" ON "submission_place" USING btree ("osm_place_id");--> statement-breakpoint
ALTER TABLE "city" ADD CONSTRAINT "city_osm_place_id_osm_place_id_fk" FOREIGN KEY ("osm_place_id") REFERENCES "public"."osm_place"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "city" ADD CONSTRAINT "city_osm_place_id_unique" UNIQUE("osm_place_id");