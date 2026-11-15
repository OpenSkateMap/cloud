DROP MATERIALIZED VIEW "public"."spot_score";--> statement-breakpoint
DROP TABLE "spot_curation" CASCADE;--> statement-breakpoint
-- Hand-written: the curators' rating is gone, and so are its audit events, which the new check would refuse.
DELETE FROM "review_event" WHERE "action" = 'rate';--> statement-breakpoint
ALTER TABLE "review_event" DROP CONSTRAINT "review_event_action_known";--> statement-breakpoint
ALTER TABLE "review_event" ADD CONSTRAINT "review_event_action_known" CHECK ("review_event"."action" in ('approve', 'reject', 'undo', 'remove'));--> statement-breakpoint
CREATE MATERIALIZED VIEW "public"."spot_score" AS (
  with votes as (
    select "spot_vote"."spot_id" as spot_id,
      (count(*) filter (where "spot_vote"."value" = 1))::int as up,
      (count(*) filter (where "spot_vote"."value" = -1))::int as down,
      max("spot_vote"."updated_at") as last_vote
    from "spot_vote"
    group by 1
  ),
  photos as (
    select "spot_photo"."spot_id" as spot_id, count(*)::int as n from "spot_photo" group by 1
  ),
  videos as (
    select "spot_video"."spot_id" as spot_id, count(*)::int as n, max(coalesce("spot_video"."reviewed_at", "spot_video"."created_at")) as last_video
    from "spot_video"
    where "spot_video"."status" = 'approved'
    group by 1
  ),
  saves as (
    select "collection_spot"."spot_id" as spot_id, count(distinct "collection"."owner_id")::int as n
    from "collection_spot"
    join "collection" on "collection"."id" = "collection_spot"."collection_id"
    group by 1
  ),
  terms as (
    select "spot"."id" as spot_id,
      coalesce(votes.up, 0) as up,
      coalesce(votes.down, 0) as down,
      case "spot"."condition"
        when 'skateable' then 1
        when 'knobbed' then 0.6
        when 'busty' then 0.35
        else 0.05
      end::float8 as condition_factor,
      ((coalesce(votes.up, 0) + 3.5) / (coalesce(votes.up, 0) + coalesce(votes.down, 0) + 5))::float8 as community,
      (1 - exp(-coalesce(saves.n, 0) / 5.0))::float8 as saves,
      (0.6 * least(coalesce(photos.n, 0), 5) / 5.0
        + 0.4 * least(coalesce(videos.n, 0), 3) / 3.0)::float8 as media,
      exp(-extract(epoch from (now() - greatest("spot"."created_at", votes.last_vote, videos.last_video))) / 86400 / 120)::float8 as activity
    from "spot"
    left join votes on votes.spot_id = "spot"."id"
    left join photos on photos.spot_id = "spot"."id"
    left join videos on videos.spot_id = "spot"."id"
    left join saves on saves.spot_id = "spot"."id"
    where "spot"."status" = 'published' and "spot"."visibility" = 'public'
  )
  select spot_id, up, down,
    round(least(1, greatest(0, condition_factor * (
      0.5 * community + 0.2 * saves
      + 0.2 * media + 0.1 * least(activity, 1)
    )))::numeric, 4)::float8 as score
  from terms
);--> statement-breakpoint
-- Hand-written (Drizzle can't index a view): REFRESH ... CONCURRENTLY needs a unique index.
CREATE UNIQUE INDEX "spot_score_spot_id" ON "spot_score" USING btree ("spot_id");
