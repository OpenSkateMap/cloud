ALTER TABLE "spot" ADD COLUMN "search_text" text GENERATED ALWAYS AS (search_words("spot"."title")) STORED NOT NULL;--> statement-breakpoint
CREATE INDEX "spot_search_trgm" ON "spot" USING gin ("search_text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "spot_city_idx" ON "spot" USING btree ("city_id");