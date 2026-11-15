DROP INDEX "spot_location_gist";--> statement-breakpoint
DROP INDEX "spot_city_idx";--> statement-breakpoint
DROP INDEX "review_event_submission_idx";--> statement-breakpoint
DROP INDEX "review_event_video_idx";--> statement-breakpoint
DROP INDEX "review_event_spot_idx";--> statement-breakpoint
CREATE INDEX "spot_created_by_idx" ON "spot" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "photo_upload_uploaded_by_idx" ON "photo_upload" USING btree ("uploaded_by");--> statement-breakpoint
CREATE INDEX "submission_collection_idx" ON "submission" USING btree ("collection_id") WHERE "submission"."collection_id" is not null;--> statement-breakpoint
CREATE INDEX "submission_reviewed_by_idx" ON "submission" USING btree ("reviewed_by") WHERE "submission"."reviewed_by" is not null;--> statement-breakpoint
CREATE INDEX "review_event_actor_idx" ON "review_event" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "profile_avatar_photo_idx" ON "profile" USING btree ("avatar_photo_id") WHERE "profile"."avatar_photo_id" is not null;--> statement-breakpoint
CREATE INDEX "collection_spot_page_idx" ON "collection_spot" USING btree ("collection_id","added_at","spot_id");--> statement-breakpoint
CREATE INDEX "review_event_submission_idx" ON "review_event" USING btree ("submission_id") WHERE "review_event"."submission_id" is not null;--> statement-breakpoint
CREATE INDEX "review_event_video_idx" ON "review_event" USING btree ("video_id") WHERE "review_event"."video_id" is not null;--> statement-breakpoint
CREATE INDEX "review_event_spot_idx" ON "review_event" USING btree ("spot_id") WHERE "review_event"."spot_id" is not null;--> statement-breakpoint
ALTER TABLE "spot" ADD CONSTRAINT "spot_description_length" CHECK (char_length("spot"."description") <= 2000);--> statement-breakpoint
ALTER TABLE "submission" ADD CONSTRAINT "submission_description_length" CHECK (char_length("submission"."description") <= 2000);--> statement-breakpoint
ALTER TABLE "submission" ADD CONSTRAINT "submission_note_length" CHECK (char_length("submission"."note") <= 500);--> statement-breakpoint
ALTER TABLE "profile" ADD CONSTRAINT "profile_bio_length" CHECK (char_length("profile"."bio") <= 160);--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_message_length" CHECK (char_length("report"."message") <= 500);--> statement-breakpoint
-- Hand-written (Drizzle can't say INCLUDE): vote totals read the value from the primary key's index alone.
CREATE UNIQUE INDEX "spot_vote_pk_covering" ON "spot_vote" USING btree ("spot_id", "user_id") INCLUDE ("value");--> statement-breakpoint
ALTER TABLE "spot_vote" DROP CONSTRAINT "spot_vote_spot_id_user_id_pk";--> statement-breakpoint
ALTER TABLE "spot_vote" ADD CONSTRAINT "spot_vote_spot_id_user_id_pk" PRIMARY KEY USING INDEX "spot_vote_pk_covering";--> statement-breakpoint
-- Hand-written: Better Auth generates the user table (schema/auth.ts), so its CHECK lives only here.
ALTER TABLE "user" ADD CONSTRAINT "user_role_known" CHECK ("role" in ('user', 'editor', 'admin'));
