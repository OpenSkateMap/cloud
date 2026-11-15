CREATE TABLE "spot_curation" (
	"spot_id" text PRIMARY KEY NOT NULL,
	"rating" smallint NOT NULL,
	"rated_by" text,
	"rated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spot_curation_rating" CHECK ("spot_curation"."rating" between 1 and 5)
);
--> statement-breakpoint
ALTER TABLE "review_event" DROP CONSTRAINT "review_event_one_subject";--> statement-breakpoint
ALTER TABLE "review_event" ADD COLUMN "spot_id" text;--> statement-breakpoint
ALTER TABLE "spot_curation" ADD CONSTRAINT "spot_curation_spot_id_spot_id_fk" FOREIGN KEY ("spot_id") REFERENCES "public"."spot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spot_curation" ADD CONSTRAINT "spot_curation_rated_by_user_id_fk" FOREIGN KEY ("rated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_event" ADD CONSTRAINT "review_event_spot_id_spot_id_fk" FOREIGN KEY ("spot_id") REFERENCES "public"."spot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_event_spot_idx" ON "review_event" USING btree ("spot_id","created_at");--> statement-breakpoint
ALTER TABLE "review_event" ADD CONSTRAINT "review_event_one_subject" CHECK (num_nonnulls("review_event"."submission_id", "review_event"."video_id", "review_event"."spot_id") = 1);