ALTER TABLE "review_event" DROP CONSTRAINT "review_event_action_known";--> statement-breakpoint
ALTER TABLE "review_event" ADD CONSTRAINT "review_event_action_known" CHECK ("action" IN ('approve', 'reject', 'undo', 'rate'));
