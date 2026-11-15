import { sql } from "drizzle-orm";
import { doublePrecision, integer, pgMaterializedView, text } from "drizzle-orm/pg-core";
import { collection, collectionSpot } from "./collections.ts";
import { spot, spotPhoto } from "./spots.ts";
import { spotVideo } from "./videos.ts";
import { spotVote } from "./votes.ts";

// The reasoning behind the weights is docs/insights/spot-score.md (SpotMap): change both together.
export const SPOT_SCORE = {
  weights: { community: 0.5, saves: 0.2, media: 0.2, activity: 0.1 },
  votePrior: { up: 3.5, down: 1.5 },
  savesScale: 5,
  media: { photos: 5, videos: 3, photoShare: 0.6 },
  activityDays: 120,
  condition: { skateable: 1, knobbed: 0.6, busty: 0.35, demolished: 0.05 },
} as const;

// Inlined, not bound: a view's definition can't take parameters.
const n = (value: number) => sql.raw(String(value));
const { weights: w, votePrior, media, condition } = SPOT_SCORE;

/**
 * Every published public spot's Spot Score (0…1) and vote totals, refreshed by the API's cron. Changing the query
 * recreates the view: the migration must add its unique index and `GRANT MAINTAIN` again (see 0024).
 */
export const spotScore = pgMaterializedView("spot_score", {
  spotId: text("spot_id").notNull(),
  up: integer("up").notNull(),
  down: integer("down").notNull(),
  score: doublePrecision("score").notNull(),
}).as(sql`
  with votes as (
    select ${spotVote.spotId} as spot_id,
      (count(*) filter (where ${spotVote.value} = 1))::int as up,
      (count(*) filter (where ${spotVote.value} = -1))::int as down,
      max(${spotVote.updatedAt}) as last_vote
    from ${spotVote}
    group by 1
  ),
  photos as (
    select ${spotPhoto.spotId} as spot_id, count(*)::int as n from ${spotPhoto} group by 1
  ),
  videos as (
    select ${spotVideo.spotId} as spot_id, count(*)::int as n, max(coalesce(${spotVideo.reviewedAt}, ${spotVideo.createdAt})) as last_video
    from ${spotVideo}
    where ${spotVideo.status} = 'approved'
    group by 1
  ),
  saves as (
    select ${collectionSpot.spotId} as spot_id, count(distinct ${collection.ownerId})::int as n
    from ${collectionSpot}
    join ${collection} on ${collection.id} = ${collectionSpot.collectionId}
    group by 1
  ),
  terms as (
    select ${spot.id} as spot_id,
      coalesce(votes.up, 0) as up,
      coalesce(votes.down, 0) as down,
      case ${spot.condition}
        when 'skateable' then ${n(condition.skateable)}
        when 'knobbed' then ${n(condition.knobbed)}
        when 'busty' then ${n(condition.busty)}
        else ${n(condition.demolished)}
      end::float8 as condition_factor,
      ((coalesce(votes.up, 0) + ${n(votePrior.up)}) / (coalesce(votes.up, 0) + coalesce(votes.down, 0) + ${n(votePrior.up + votePrior.down)}))::float8 as community,
      (1 - exp(-coalesce(saves.n, 0) / ${n(SPOT_SCORE.savesScale)}.0))::float8 as saves,
      (${n(media.photoShare)} * least(coalesce(photos.n, 0), ${n(media.photos)}) / ${n(media.photos)}.0
        + ${n(1 - media.photoShare)} * least(coalesce(videos.n, 0), ${n(media.videos)}) / ${n(media.videos)}.0)::float8 as media,
      exp(-extract(epoch from (now() - greatest(${spot.createdAt}, votes.last_vote, videos.last_video))) / 86400 / ${n(SPOT_SCORE.activityDays)})::float8 as activity
    from ${spot}
    left join votes on votes.spot_id = ${spot.id}
    left join photos on photos.spot_id = ${spot.id}
    left join videos on videos.spot_id = ${spot.id}
    left join saves on saves.spot_id = ${spot.id}
    where ${spot.status} = 'published' and ${spot.visibility} = 'public'
  )
  select spot_id, up, down,
    round(least(1, greatest(0, condition_factor * (
      ${n(w.community)} * community + ${n(w.saves)} * saves
      + ${n(w.media)} * media + ${n(w.activity)} * least(activity, 1)
    )))::numeric, 4)::float8 as score
  from terms
`);
