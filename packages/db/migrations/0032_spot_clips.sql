CREATE TABLE "clip_upload" (
	"id" text PRIMARY KEY NOT NULL,
	"uploaded_by" text,
	"r2_key" text NOT NULL,
	"bytes" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clip_upload_duration" CHECK ("clip_upload"."duration_ms" between 1 and 16000)
);
--> statement-breakpoint
ALTER TABLE "spot_photo" ADD COLUMN "clip_id" text;--> statement-breakpoint
ALTER TABLE "submission_photo" ADD COLUMN "clip_id" text;--> statement-breakpoint
ALTER TABLE "clip_upload" ADD CONSTRAINT "clip_upload_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clip_upload_uploaded_by_idx" ON "clip_upload" USING btree ("uploaded_by");--> statement-breakpoint
ALTER TABLE "spot_photo" ADD CONSTRAINT "spot_photo_clip_id_clip_upload_id_fk" FOREIGN KEY ("clip_id") REFERENCES "public"."clip_upload"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_photo" ADD CONSTRAINT "submission_photo_clip_id_clip_upload_id_fk" FOREIGN KEY ("clip_id") REFERENCES "public"."clip_upload"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "spot_photo_clip_idx" ON "spot_photo" USING btree ("clip_id") WHERE "spot_photo"."clip_id" is not null;--> statement-breakpoint
CREATE INDEX "submission_photo_clip_idx" ON "submission_photo" USING btree ("clip_id") WHERE "submission_photo"."clip_id" is not null;