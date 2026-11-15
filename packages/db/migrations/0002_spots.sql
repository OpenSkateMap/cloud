CREATE SEQUENCE "public"."spot_version_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "city" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"country_code" text NOT NULL,
	"area" geometry(MultiPolygon, 4326) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "city_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "spot" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'published' NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"location" geometry(Point, 4326) NOT NULL,
	"city_id" text,
	"kind" text NOT NULL,
	"obstacles" text[] DEFAULT '{}'::text[] NOT NULL,
	"condition" text DEFAULT 'skateable' NOT NULL,
	"created_by" text,
	"approved_by" text,
	"version" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spot_title_length" CHECK (char_length("spot"."title") between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "spot_photo" (
	"id" text PRIMARY KEY NOT NULL,
	"spot_id" text NOT NULL,
	"r2_key" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"thumbhash" text NOT NULL,
	"credit" text NOT NULL,
	"has_permission" boolean NOT NULL,
	"source_url" text,
	"uploaded_by" text,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spot" ADD CONSTRAINT "spot_city_id_city_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."city"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spot" ADD CONSTRAINT "spot_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spot" ADD CONSTRAINT "spot_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spot_photo" ADD CONSTRAINT "spot_photo_spot_id_spot_id_fk" FOREIGN KEY ("spot_id") REFERENCES "public"."spot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spot_photo" ADD CONSTRAINT "spot_photo_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "city_area_gist" ON "city" USING gist ("area");--> statement-breakpoint
CREATE INDEX "spot_location_gist" ON "spot" USING gist ("location");--> statement-breakpoint
CREATE INDEX "spot_location_geography_gist" ON "spot" USING gist (("location"::geography));--> statement-breakpoint
CREATE INDEX "spot_version_idx" ON "spot" USING btree ("version");--> statement-breakpoint
CREATE INDEX "spot_city_idx" ON "spot" USING btree ("city_id");--> statement-breakpoint
CREATE UNIQUE INDEX "spot_photo_spot_position" ON "spot_photo" USING btree ("spot_id","position");