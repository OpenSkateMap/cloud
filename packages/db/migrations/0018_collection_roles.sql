CREATE TABLE "collection_request" (
	"collection_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_request_collection_id_user_id_pk" PRIMARY KEY("collection_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "collection_member" DROP CONSTRAINT "collection_member_role_known";--> statement-breakpoint
ALTER TABLE "collection_invite" ALTER COLUMN "email_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "collection_invite" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "collection_invite" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "collection_invite" ADD COLUMN "role" text DEFAULT 'viewer' NOT NULL;--> statement-breakpoint
ALTER TABLE "collection_request" ADD CONSTRAINT "collection_request_collection_id_collection_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_request" ADD CONSTRAINT "collection_request_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collection_request_user_idx" ON "collection_request" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "collection_invite" ADD CONSTRAINT "collection_invite_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "collection_invite_user_unique" ON "collection_invite" USING btree ("collection_id","user_id");--> statement-breakpoint
CREATE INDEX "collection_invite_user_idx" ON "collection_invite" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "collection_invite" ADD CONSTRAINT "collection_invite_addressed" CHECK ("collection_invite"."email_hash" is not null or "collection_invite"."user_id" is not null);--> statement-breakpoint
ALTER TABLE "collection_invite" ADD CONSTRAINT "collection_invite_role_known" CHECK ("collection_invite"."role" in ('viewer', 'editor', 'admin'));--> statement-breakpoint
ALTER TABLE "collection_member" ADD CONSTRAINT "collection_member_role_known" CHECK ("collection_member"."role" in ('viewer', 'editor', 'admin'));