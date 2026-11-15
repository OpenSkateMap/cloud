CREATE TABLE "apple_token" (
	"user_id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"refresh_token" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "apple_token" ADD CONSTRAINT "apple_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;