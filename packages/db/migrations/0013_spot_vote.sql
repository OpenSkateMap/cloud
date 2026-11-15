CREATE TABLE "spot_vote" (
	"spot_id" text NOT NULL,
	"user_id" text NOT NULL,
	"value" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spot_vote_spot_id_user_id_pk" PRIMARY KEY("spot_id","user_id"),
	CONSTRAINT "spot_vote_value" CHECK ("spot_vote"."value" in (-1, 1))
);
--> statement-breakpoint
ALTER TABLE "spot_vote" ADD CONSTRAINT "spot_vote_spot_id_spot_id_fk" FOREIGN KEY ("spot_id") REFERENCES "public"."spot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spot_vote" ADD CONSTRAINT "spot_vote_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "spot_vote_user_idx" ON "spot_vote" USING btree ("user_id");