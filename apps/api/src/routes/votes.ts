import { z } from "@hono/zod-openapi";
import { success } from "../lib/envelope.ts";
import { createRouter } from "../lib/openapi-app.ts";
import { respondError } from "../lib/respond.ts";
import { answers, authedRoute, jsonBody } from "../lib/routes.ts";
import { IdSchema, SpotScoresSchema, SpotVoteDraftSchema, SpotVotesSchema } from "../lib/spot-schemas.ts";
import { sharedAnswer } from "../lib/shared-answer.ts";
import { limitWrites } from "../middleware/rate-limit.ts";
import { spotScores } from "../services/spot-score.ts";
import { voteOnSpot } from "../services/votes.ts";
import { track } from "../lib/posthog.ts";

const SCORES_MAX_AGE_SECONDS = 60;

const voteOnSpotRoute = authedRoute(
  {
    method: "put",
    path: "/v1/spots/{spotId}/vote",
    operationId: "voteOnSpot",
    tags: ["spots"],
    summary: "Vote a spot up or down, or clear your vote",
    description:
      "One vote per rider and spot: sending a vote replaces yours, sending the same one again changes nothing, and 0 clears it. Answers the spot's totals with your vote. A spot that isn't published is a 404.",
    request: {
      params: z.object({ spotId: IdSchema }),
      body: jsonBody(SpotVoteDraftSchema),
    },
    responses: answers(SpotVotesSchema, "VoteOnSpotResponse", "The spot's votes after yours"),
  },
  limitWrites("votes"),
);

const getSpotScoresRoute = authedRoute({
  method: "get",
  path: "/v1/spot-scores",
  operationId: "getSpotScores",
  tags: ["spots"],
  summary: "Every public spot's Spot Score",
  description:
    "The Spot Score (0…1) and vote totals of every published public spot, best first, for ranking spots offline: riders' votes, saves, media, activity and condition in one number. Votes don't move a spot's version, so scores come from here, not the sync index. Cached for a minute.",
  responses: answers(SpotScoresSchema, "GetSpotScoresResponse", "Every public spot's score"),
});

export const votes = createRouter()
  .openapi(voteOnSpotRoute, async (c) => {
    const { spotId } = c.req.valid("param");
    const { value } = c.req.valid("json");
    const voted = await voteOnSpot(c.var.database.db, c.var.user.id, spotId, value);
    if (voted.isErr()) return respondError(c, voted.error);
    const { votes, changedAt } = voted.value;
    if (changedAt) track(c, "spot_voted", { value }, `${c.var.user.id}:${spotId}:${value}:${changedAt.toISOString()}`);
    return c.json(success(votes), 200);
  })
  .openapi(getSpotScoresRoute, async (c) => {
    const scores = await sharedAnswer(
      {
        key: new URL(c.req.path, c.req.url).href,
        seconds: SCORES_MAX_AGE_SECONDS,
        schema: SpotScoresSchema,
        waitUntil: (promise) => c.executionCtx.waitUntil(promise),
      },
      () => spotScores(c.var.database.db),
    );
    c.header("Cache-Control", `private, max-age=${SCORES_MAX_AGE_SECONDS}`);
    return c.json(success(scores), 200);
  });
