ALTER TABLE "review_event" DROP CONSTRAINT "review_event_action_known";--> statement-breakpoint
ALTER TABLE "spot" ADD COLUMN "removal_reason" text;--> statement-breakpoint
ALTER TABLE "spot" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
-- Hand-written: spots taken down before reasons existed keep their takedown, as "other".
UPDATE "spot" SET "removal_reason" = 'other', "removed_at" = "taken"."at"
FROM (SELECT "spot_id", max("created_at") AS "at" FROM "review_event" WHERE "action" = 'remove' GROUP BY "spot_id") AS "taken"
WHERE "spot"."id" = "taken"."spot_id" AND "spot"."status" = 'removed';--> statement-breakpoint
ALTER TABLE "spot" ADD CONSTRAINT "spot_removal_reason_known" CHECK ("spot"."removal_reason" in ('duplicate', 'private_property', 'unsafe_or_gone', 'not_a_spot', 'other'));--> statement-breakpoint
ALTER TABLE "spot" ADD CONSTRAINT "spot_removal_shape" CHECK (("spot"."removal_reason" is null) = ("spot"."removed_at" is null) and ("spot"."removal_reason" is null or "spot"."status" = 'removed'));--> statement-breakpoint
ALTER TABLE "review_event" ADD CONSTRAINT "review_event_action_known" CHECK ("review_event"."action" in ('approve', 'reject', 'undo', 'remove', 'restore'));