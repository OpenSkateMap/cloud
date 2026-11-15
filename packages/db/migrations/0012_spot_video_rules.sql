-- Values the API validates with Zod, enforced here too so no path can store anything else.
ALTER TABLE "spot_video" ADD CONSTRAINT "spot_video_provider_known" CHECK ("provider" IN ('youtube', 'instagram'));--> statement-breakpoint
ALTER TABLE "spot_video" ADD CONSTRAINT "spot_video_status_known" CHECK ("status" IN ('pending', 'approved', 'rejected'));--> statement-breakpoint
ALTER TABLE "spot_video" ADD CONSTRAINT "spot_video_reject_reason_known" CHECK (
  "reject_reason" IS NULL OR "reject_reason" IN ('duplicate', 'wrong_spot', 'not_skating', 'inappropriate')
);--> statement-breakpoint
-- A decision always says who made it and when; a pending video has neither.
ALTER TABLE "spot_video" ADD CONSTRAINT "spot_video_decision_complete" CHECK (
  ("status" = 'pending' AND "reviewed_at" IS NULL AND "reject_reason" IS NULL)
  OR ("status" = 'approved' AND "reviewed_at" IS NOT NULL AND "reject_reason" IS NULL)
  OR ("status" = 'rejected' AND "reviewed_at" IS NOT NULL AND "reject_reason" IS NOT NULL)
);--> statement-breakpoint
ALTER TABLE "spot_video" ADD CONSTRAINT "spot_video_start_seconds_range" CHECK ("start_seconds" IS NULL OR "start_seconds" BETWEEN 1 AND 86399);--> statement-breakpoint
ALTER TABLE "report" DROP CONSTRAINT "report_target_known";--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_target_known" CHECK ("target_kind" IN ('spot', 'user', 'video'));--> statement-breakpoint
-- A video appearing on or leaving a spot is a change to that spot: it gets a new version (migration 0003), so apps
-- that synced the spot fetch its details again. Pending and rejected videos don't touch it.
CREATE FUNCTION "spot_video_touch_spot"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.status = 'approved')
    OR (TG_OP = 'UPDATE' AND (OLD.status = 'approved') <> (NEW.status = 'approved'))
    OR (TG_OP = 'DELETE' AND OLD.status = 'approved') THEN
    UPDATE spot SET updated_at = now() WHERE id = COALESCE(NEW.spot_id, OLD.spot_id);
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER "spot_video_touch_spot" AFTER INSERT OR UPDATE OR DELETE ON "spot_video"
  FOR EACH ROW EXECUTE FUNCTION "spot_video_touch_spot"();
