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
      coalesce(("spot_curation"."rating" - 1) / 4.0, 0.4)::float8 as editorial,
      ((coalesce(votes.up, 0) + 3.5) / (coalesce(votes.up, 0) + coalesce(votes.down, 0) + 5))::float8 as community,
      (1 - exp(-coalesce(saves.n, 0) / 5.0))::float8 as saves,
      (0.6 * least(coalesce(photos.n, 0), 5) / 5.0
        + 0.4 * least(coalesce(videos.n, 0), 3) / 3.0)::float8 as media,
      exp(-extract(epoch from (now() - greatest("spot"."created_at", votes.last_vote, videos.last_video))) / 86400 / 120)::float8 as activity
    from "spot"
    left join "spot_curation" on "spot_curation"."spot_id" = "spot"."id"
    left join votes on votes.spot_id = "spot"."id"
    left join photos on photos.spot_id = "spot"."id"
    left join videos on videos.spot_id = "spot"."id"
    left join saves on saves.spot_id = "spot"."id"
    where "spot"."status" = 'published' and "spot"."visibility" = 'public'
  )
  select spot_id, up, down,
    round(least(1, greatest(0, condition_factor * (
      0.4 * editorial + 0.3 * community + 0.12 * saves
      + 0.12 * media + 0.06 * least(activity, 1)
    )))::numeric, 4)::float8 as score
  from terms
);--> statement-breakpoint
-- Hand-written (Drizzle can't index a view): REFRESH ... CONCURRENTLY needs a unique index.
CREATE UNIQUE INDEX "spot_score_spot_id" ON "spot_score" USING btree ("spot_id");--> statement-breakpoint
-- The Worker's role owns nothing and is named per environment, so the refresh runs as the view's owner.
CREATE FUNCTION "refresh_spot_score"() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$ BEGIN REFRESH MATERIALIZED VIEW CONCURRENTLY "spot_score"; END $$;
