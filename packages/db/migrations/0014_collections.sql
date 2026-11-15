CREATE TABLE "collection" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_name_length" CHECK (char_length("collection"."name") between 1 and 60),
	CONSTRAINT "collection_description_length" CHECK (char_length("collection"."description") <= 300),
	CONSTRAINT "collection_visibility_known" CHECK ("collection"."visibility" in ('private', 'public'))
);
--> statement-breakpoint
CREATE TABLE "collection_invite" (
	"id" text PRIMARY KEY NOT NULL,
	"collection_id" text NOT NULL,
	"email_hash" text NOT NULL,
	"email" text NOT NULL,
	"invited_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collection_member" (
	"collection_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'viewer' NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_member_collection_id_user_id_pk" PRIMARY KEY("collection_id","user_id"),
	CONSTRAINT "collection_member_role_known" CHECK ("collection_member"."role" in ('viewer'))
);
--> statement-breakpoint
CREATE TABLE "collection_spot" (
	"collection_id" text NOT NULL,
	"spot_id" text NOT NULL,
	"added_by" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_spot_collection_id_spot_id_pk" PRIMARY KEY("collection_id","spot_id")
);
--> statement-breakpoint
ALTER TABLE "spot" ADD COLUMN "visibility" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "submission" ADD COLUMN "collection_id" text;--> statement-breakpoint
ALTER TABLE "collection" ADD CONSTRAINT "collection_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_invite" ADD CONSTRAINT "collection_invite_collection_id_collection_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_invite" ADD CONSTRAINT "collection_invite_invited_by_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_member" ADD CONSTRAINT "collection_member_collection_id_collection_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_member" ADD CONSTRAINT "collection_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_spot" ADD CONSTRAINT "collection_spot_collection_id_collection_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_spot" ADD CONSTRAINT "collection_spot_spot_id_spot_id_fk" FOREIGN KEY ("spot_id") REFERENCES "public"."spot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_spot" ADD CONSTRAINT "collection_spot_added_by_user_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collection_owner_idx" ON "collection" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "collection_invite_email_unique" ON "collection_invite" USING btree ("collection_id","email_hash");--> statement-breakpoint
CREATE INDEX "collection_invite_email_idx" ON "collection_invite" USING btree ("email_hash");--> statement-breakpoint
CREATE INDEX "collection_member_user_idx" ON "collection_member" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "collection_spot_spot_idx" ON "collection_spot" USING btree ("spot_id");--> statement-breakpoint
ALTER TABLE "submission" ADD CONSTRAINT "submission_collection_id_collection_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collection"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "spot_private_idx" ON "spot" USING btree ("created_by") WHERE "spot"."visibility" = 'private';--> statement-breakpoint
ALTER TABLE "spot" ADD CONSTRAINT "spot_visibility_known" CHECK ("spot"."visibility" in ('public', 'private'));