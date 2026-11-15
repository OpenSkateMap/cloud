CREATE TABLE "spot_video" (
	"id" text PRIMARY KEY NOT NULL,
	"spot_id" text NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"url" text NOT NULL,
	"start_seconds" integer,
	"caption" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"submitted_by" text,
	"reject_reason" text,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spot_video_caption_length" CHECK (char_length("spot_video"."caption") <= 120)
);
--> statement-breakpoint
ALTER TABLE "review_event" ALTER COLUMN "submission_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "review_event" ADD COLUMN "video_id" text;--> statement-breakpoint
ALTER TABLE "spot_video" ADD CONSTRAINT "spot_video_spot_id_spot_id_fk" FOREIGN KEY ("spot_id") REFERENCES "public"."spot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spot_video" ADD CONSTRAINT "spot_video_submitted_by_user_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spot_video" ADD CONSTRAINT "spot_video_reviewed_by_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "spot_video_approved_idx" ON "spot_video" USING btree ("spot_id","created_at") WHERE "spot_video"."status" = 'approved';--> statement-breakpoint
CREATE INDEX "spot_video_pending_idx" ON "spot_video" USING btree ("created_at") WHERE "spot_video"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "spot_video_clip_unique" ON "spot_video" USING btree ("spot_id","provider","external_id") WHERE "spot_video"."status" <> 'rejected';--> statement-breakpoint
ALTER TABLE "review_event" ADD CONSTRAINT "review_event_video_id_spot_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."spot_video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_event_video_idx" ON "review_event" USING btree ("video_id","created_at");--> statement-breakpoint
ALTER TABLE "review_event" ADD CONSTRAINT "review_event_one_subject" CHECK (num_nonnulls("review_event"."submission_id", "review_event"."video_id") = 1);