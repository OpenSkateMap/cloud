ALTER TABLE "submission_photo" ALTER COLUMN "photo_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "submission" ADD COLUMN "base_photo_ids" text[];--> statement-breakpoint
ALTER TABLE "submission_photo" ADD COLUMN "spot_photo_id" text;--> statement-breakpoint
ALTER TABLE "submission_photo" ADD CONSTRAINT "submission_photo_source" CHECK (("submission_photo"."photo_id" is null) <> ("submission_photo"."spot_photo_id" is null));