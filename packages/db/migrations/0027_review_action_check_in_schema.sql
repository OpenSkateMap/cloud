ALTER TABLE "review_event" DROP CONSTRAINT IF EXISTS "review_event_action_known";--> statement-breakpoint
ALTER TABLE "review_event" ADD CONSTRAINT "review_event_action_known" CHECK ("review_event"."action" in ('approve', 'reject', 'undo', 'rate', 'remove'));
