-- Values the API validates with Zod, enforced here too so no path can store anything else.
ALTER TABLE "spot" ADD CONSTRAINT "spot_status_known" CHECK ("status" IN ('published', 'removed'));--> statement-breakpoint
ALTER TABLE "spot" ADD CONSTRAINT "spot_kind_known" CHECK ("kind" IN ('street', 'park', 'diy', 'plaza'));--> statement-breakpoint
ALTER TABLE "spot" ADD CONSTRAINT "spot_condition_known" CHECK ("condition" IN ('skateable', 'knobbed', 'demolished', 'busty'));--> statement-breakpoint

-- The one rule for which city a spot is in: the smallest city area that contains it (ties broken by id).
CREATE FUNCTION "spot_city_for"(location geometry) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT c.id FROM city c WHERE ST_Contains(c.area, location) ORDER BY ST_Area(c.area), c.id LIMIT 1
$$;--> statement-breakpoint

-- The sync cursor. Every insert and update takes the next version, so clients pull "everything after N".
-- The transaction-scoped advisory lock hands versions out in commit order: a concurrent writer waits here until
-- the first one commits, so it can never commit a lower version after a reader has already moved past it.
-- The same trigger keeps city_id in step with the location.
CREATE FUNCTION "spot_assign_version"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('spot_version_seq'));
  NEW.version := nextval('spot_version_seq');
  NEW.updated_at := now();
  IF TG_OP = 'INSERT' OR NEW.location IS DISTINCT FROM OLD.location THEN
    NEW.city_id := spot_city_for(NEW.location);
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "spot_assign_version" BEFORE INSERT OR UPDATE ON "spot"
  FOR EACH ROW EXECUTE FUNCTION "spot_assign_version"();--> statement-breakpoint

-- A spot's index row carries its cover photo, so a photo change is a spot change: touch the spot, which takes
-- a new version through the trigger above.
CREATE FUNCTION "spot_photo_touch_spot"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE spot SET updated_at = now() WHERE id = COALESCE(NEW.spot_id, OLD.spot_id);
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER "spot_photo_touch_spot" AFTER INSERT OR UPDATE OR DELETE ON "spot_photo"
  FOR EACH ROW EXECUTE FUNCTION "spot_photo_touch_spot"();
