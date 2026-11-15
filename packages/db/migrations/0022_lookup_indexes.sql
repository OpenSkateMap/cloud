CREATE INDEX "submission_photo_photo_idx" ON "submission_photo" USING btree ("photo_id");--> statement-breakpoint
CREATE INDEX "collection_photo_idx" ON "collection" USING btree ("photo_id") WHERE "collection"."photo_id" is not null;--> statement-breakpoint
CREATE INDEX "collection_invite_invited_by_idx" ON "collection_invite" USING btree ("invited_by") WHERE "collection_invite"."invited_by" is not null;--> statement-breakpoint
CREATE INDEX "collection_spot_added_by_idx" ON "collection_spot" USING btree ("added_by") WHERE "collection_spot"."added_by" is not null;--> statement-breakpoint
CREATE INDEX "user_reviewer_role_idx" ON "user" USING btree ("role") WHERE "user"."role" in ('admin', 'editor');
