CREATE TABLE "photo_upload" (
	"id" text PRIMARY KEY NOT NULL,
	"uploaded_by" text,
	"r2_key" text NOT NULL,
	"bytes" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submission" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"submitted_by" text,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"spot_kind" text NOT NULL,
	"obstacles" text[] DEFAULT '{}'::text[] NOT NULL,
	"condition" text DEFAULT 'skateable' NOT NULL,
	"location" geometry(Point, 4326) NOT NULL,
	"city_id" text,
	"note" text DEFAULT '' NOT NULL,
	"spot_id" text,
	"reject_reason" text,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "submission_title_length" CHECK (char_length("submission"."title") between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "submission_photo" (
	"submission_id" text NOT NULL,
	"photo_id" text NOT NULL,
	"position" integer NOT NULL,
	"thumbhash" text NOT NULL,
	"credit" text,
	"has_permission" boolean NOT NULL,
	"source_url" text,
	CONSTRAINT "submission_photo_submission_id_position_pk" PRIMARY KEY("submission_id","position"),
	CONSTRAINT "submission_photo_rights" CHECK ("submission_photo"."credit" is null or "submission_photo"."has_permission")
);
--> statement-breakpoint
ALTER TABLE "spot_photo" ALTER COLUMN "credit" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "photo_upload" ADD CONSTRAINT "photo_upload_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission" ADD CONSTRAINT "submission_submitted_by_user_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission" ADD CONSTRAINT "submission_city_id_city_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."city"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission" ADD CONSTRAINT "submission_spot_id_spot_id_fk" FOREIGN KEY ("spot_id") REFERENCES "public"."spot"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission" ADD CONSTRAINT "submission_reviewed_by_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_photo" ADD CONSTRAINT "submission_photo_submission_id_submission_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submission"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_photo" ADD CONSTRAINT "submission_photo_photo_id_photo_upload_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."photo_upload"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "submission_submitted_by_idx" ON "submission" USING btree ("submitted_by","created_at");--> statement-breakpoint
CREATE INDEX "submission_pending_city_idx" ON "submission" USING btree ("city_id","created_at") WHERE "submission"."status" = 'pending';--> statement-breakpoint
ALTER TABLE "spot_photo" ADD CONSTRAINT "spot_photo_rights" CHECK ("spot_photo"."credit" is null or "spot_photo"."has_permission");