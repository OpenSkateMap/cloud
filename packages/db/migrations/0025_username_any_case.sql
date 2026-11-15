-- Usernames keep their case; uniqueness and lookups ignore it.
CREATE UNIQUE INDEX "profile_username_lower_unique" ON "profile" USING btree (lower("username"));--> statement-breakpoint
DROP INDEX "profile_username_unique";--> statement-breakpoint
ALTER TABLE "profile" DROP CONSTRAINT "profile_username_lowercase";--> statement-breakpoint
-- Names with dots or under 5 characters aren't usernames any more; their owners pick a new one.
UPDATE "profile" SET "username" = NULL WHERE "username" !~ '^[A-Za-z0-9_]{5,24}$';--> statement-breakpoint
ALTER TABLE "profile" ADD CONSTRAINT "profile_username_format" CHECK ("username" ~ '^[A-Za-z0-9_]{5,24}$');
