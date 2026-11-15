-- Values the API validates with Zod, enforced here too so no path can store anything else.
ALTER TABLE "report" ADD CONSTRAINT "report_target_known" CHECK ("target_kind" IN ('spot', 'user'));--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_reason_known" CHECK ("reason" IN ('inappropriate', 'spam', 'wrong_info', 'private_property', 'photo_rights', 'harassment', 'other'));--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_status_known" CHECK ("status" IN ('open', 'resolved'));--> statement-breakpoint
-- Usernames are stored the way they are compared.
ALTER TABLE "profile" ADD CONSTRAINT "profile_username_lowercase" CHECK ("username" = lower("username"));
