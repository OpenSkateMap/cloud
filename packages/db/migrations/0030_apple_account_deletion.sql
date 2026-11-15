CREATE TABLE "apple_account_deletion" (
	"user_id" text PRIMARY KEY NOT NULL,
	"noticed_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "apple_account_deletion" ADD CONSTRAINT "apple_account_deletion_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "apple_account_deletion_due_idx" ON "apple_account_deletion" USING btree ("due_at");