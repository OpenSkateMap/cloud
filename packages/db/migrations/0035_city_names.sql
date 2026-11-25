ALTER TABLE "city" ADD COLUMN "names" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "city" ADD COLUMN "wikidata_id" text;--> statement-breakpoint
ALTER TABLE "city" ADD CONSTRAINT "city_names_object" CHECK (jsonb_typeof("city"."names") = 'object');--> statement-breakpoint
ALTER TABLE "city" ADD CONSTRAINT "city_wikidata_id_format" CHECK ("city"."wikidata_id" ~ '^Q[1-9][0-9]*$');