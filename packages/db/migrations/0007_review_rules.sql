-- Values the API validates with Zod, enforced here too so no path can store anything else.
ALTER TABLE "review_event" ADD CONSTRAINT "review_event_action_known" CHECK ("action" IN ('approve', 'reject', 'undo'));--> statement-breakpoint
ALTER TABLE "submission" ADD CONSTRAINT "submission_reject_reason_known" CHECK (
  "reject_reason" IS NULL OR "reject_reason" IN ('duplicate', 'not_a_spot', 'wrong_location', 'private_property', 'photo_rights')
);--> statement-breakpoint
-- A decision always says who made it and when; a pending submission has neither.
ALTER TABLE "submission" ADD CONSTRAINT "submission_decision_complete" CHECK (
  ("status" = 'pending' AND "reviewed_at" IS NULL AND "reject_reason" IS NULL)
  OR ("status" = 'approved' AND "reviewed_at" IS NOT NULL AND "spot_id" IS NOT NULL)
  OR ("status" = 'rejected' AND "reviewed_at" IS NOT NULL AND "reject_reason" IS NOT NULL)
);
