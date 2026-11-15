-- Values the API validates with Zod, enforced here too so no path can store anything else.
ALTER TABLE "submission" ADD CONSTRAINT "submission_kind_known" CHECK ("kind" IN ('new_spot'));--> statement-breakpoint
ALTER TABLE "submission" ADD CONSTRAINT "submission_status_known" CHECK ("status" IN ('pending', 'approved', 'rejected'));--> statement-breakpoint
ALTER TABLE "submission" ADD CONSTRAINT "submission_spot_kind_known" CHECK ("spot_kind" IN ('street', 'park', 'diy', 'plaza'));--> statement-breakpoint
ALTER TABLE "submission" ADD CONSTRAINT "submission_condition_known" CHECK ("condition" IN ('skateable', 'knobbed', 'demolished', 'busty'));--> statement-breakpoint

-- A submission is routed to the editors of the city it is in, by the same rule spots use (spot_city_for).
CREATE FUNCTION "submission_assign_city"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  IF TG_OP = 'INSERT' OR NEW.location IS DISTINCT FROM OLD.location THEN
    NEW.city_id := spot_city_for(NEW.location);
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "submission_assign_city" BEFORE INSERT OR UPDATE ON "submission"
  FOR EACH ROW EXECUTE FUNCTION "submission_assign_city"();
