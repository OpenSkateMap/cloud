ALTER TABLE "collection" ADD COLUMN "kind" text DEFAULT 'custom' NOT NULL;--> statement-breakpoint
ALTER TABLE "collection" ADD COLUMN "color" text;--> statement-breakpoint
ALTER TABLE "collection" ADD COLUMN "pattern" text;--> statement-breakpoint
ALTER TABLE "collection" ADD COLUMN "photo_id" text;--> statement-breakpoint
ALTER TABLE "collection" ADD COLUMN "photo_thumbhash" text;--> statement-breakpoint
ALTER TABLE "collection" ADD CONSTRAINT "collection_photo_id_photo_upload_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."photo_upload"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "collection_favorites_unique" ON "collection" USING btree ("owner_id") WHERE "collection"."kind" = 'favorites';--> statement-breakpoint
ALTER TABLE "collection" ADD CONSTRAINT "collection_color_known" CHECK ("collection"."color" in ('blue', 'green', 'orange', 'red', 'purple', 'teal', 'pink', 'gray', 'sky', 'lime', 'amber', 'coral', 'violet', 'mint', 'rose', 'silver'));--> statement-breakpoint
ALTER TABLE "collection" ADD CONSTRAINT "collection_pattern_known" CHECK ("collection"."pattern" in ('skateboard', 'skater', 'flame', 'bolt', 'star', 'heart', 'night', 'sun', 'camera', 'video', 'stairs', 'cone', 'road', 'waves', 'sparkles', 'crown'));--> statement-breakpoint
ALTER TABLE "collection" ADD CONSTRAINT "collection_kind_known" CHECK ("collection"."kind" in ('custom', 'favorites'));--> statement-breakpoint
ALTER TABLE "collection" ADD CONSTRAINT "collection_photo_thumbhash" CHECK (("collection"."photo_id" is null) = ("collection"."photo_thumbhash" is null));