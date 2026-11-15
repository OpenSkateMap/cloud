ALTER TABLE "submission" ADD COLUMN "changed_fields" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
-- An edit is a second kind of submission (docs/spot-edits.md); the same values the API validates.
ALTER TABLE "submission" DROP CONSTRAINT "submission_kind_known";--> statement-breakpoint
ALTER TABLE "submission" ADD CONSTRAINT "submission_kind_known" CHECK ("kind" IN ('new_spot', 'edit_spot'));--> statement-breakpoint
ALTER TABLE "submission" ADD CONSTRAINT "submission_changed_fields_known" CHECK ("changed_fields" <@ ARRAY['title', 'description', 'spotKind', 'obstacles', 'condition', 'location', 'photos']::text[]);--> statement-breakpoint
-- A new spot changes nothing and an edit changes something, and an edit always names its spot.
ALTER TABLE "submission" ADD CONSTRAINT "submission_edit_shape" CHECK (("kind" = 'new_spot' AND cardinality("changed_fields") = 0) OR ("kind" = 'edit_spot' AND cardinality("changed_fields") > 0));
