import { z } from "@hono/zod-openapi";
import { success } from "../lib/envelope.ts";
import { createRouter } from "../lib/openapi-app.ts";
import { queryNumber } from "../lib/query.ts";
import { respondError } from "../lib/respond.ts";
import { answers, authedRoute, jsonBody } from "../lib/routes.ts";
import { IdSchema } from "../lib/spot-schemas.ts";
import { RejectReasonSchema, ReviewQueueSchema, SpotEditsSchema, SubmissionSchema } from "../lib/submission-schemas.ts";
import { limitWrites } from "../middleware/rate-limit.ts";
import { findCityAfter } from "../services/city-places.ts";
import { notifyAfter, reviewResultNotice, videoResultNotice } from "../services/notifications.ts";
import { approveSubmission, rejectSubmission, reviewQueue, undoDecision } from "../services/review.ts";
import { approveVideo, rejectVideo, undoVideoDecision } from "../services/video-review.ts";
import { VideoRejectReasonSchema, VideoSubmissionSchema } from "../lib/video-schemas.ts";
import type { Context } from "hono";
import type { AppEnv } from "../env.ts";
import { type ServerEvents, track } from "../lib/posthog.ts";

const decisionResponses = answers(SubmissionSchema, "ReviewDecisionResponse", "The submission after the decision");
const submissionParams = z.object({ submissionId: z.uuid() });
const seenUpdatedAt = z.iso.datetime().openapi({ description: "The `updatedAt` of the submission as the reviewer saw it; a resend since then answers 409" });

const getReviewQueueRoute = authedRoute(
  {
    method: "get",
    path: "/v1/review/queue",
    operationId: "getReviewQueue",
    tags: ["review"],
    summary: "Pending submissions and videos to review",
    description:
      "Editors see the cities granted to them; admins see everything, including submissions outside every city. Everyone also sees what others suggest for the spots they added (`reviewAs: owner`): the owner decides first, curators can step in any time. `limit` applies to submissions and videos separately.",
    request: {
      query: z.object({
        cityId: IdSchema.optional(),
        limit: queryNumber({ min: 1, max: 50, integer: true }).default(20),
      }),
    },
    responses: answers(ReviewQueueSchema, "GetReviewQueueResponse", "The queue, oldest first"),
  },
);

const approveRoute = authedRoute(
  {
    method: "post",
    path: "/v1/review/{submissionId}/approve",
    operationId: "approveSubmission",
    tags: ["review"],
    summary: "Publish a submission as a spot, with optional edits",
    request: {
      params: submissionParams,
      body: jsonBody(
        z.object({
          edits: SpotEditsSchema.default({}),
          seenUpdatedAt,
          wholePhotoList: z.literal(true).optional().openapi({
            description:
              "Sent by apps that show an edit's photos as the spot's whole list (kept, removed, reordered, added). An edit that changes the photos that way can't be approved without it",
          }),
        }),
      ),
    },
    responses: decisionResponses,
  },
  limitWrites("review"),
);

const rejectRoute = authedRoute(
  {
    method: "post",
    path: "/v1/review/{submissionId}/reject",
    operationId: "rejectSubmission",
    tags: ["review"],
    summary: "Reject a submission with a reason the submitter sees",
    request: {
      params: submissionParams,
      body: jsonBody(z.object({ reason: RejectReasonSchema, seenUpdatedAt })),
    },
    responses: decisionResponses,
  },
  limitWrites("review"),
);

const undoRoute = authedRoute(
  {
    method: "post",
    path: "/v1/review/{submissionId}/undo",
    operationId: "undoReviewDecision",
    tags: ["review"],
    summary: "Take a decision back",
    description:
      "The reviewer can undo their own decision for ten minutes; admins any time. Undoing an approval removes the spot. Retrying your own undo succeeds.",
    request: { params: submissionParams },
    responses: decisionResponses,
  },
  limitWrites("review"),
);

const videoDecisionResponses = answers(VideoSubmissionSchema, "VideoDecisionResponse", "The video after the decision");
const videoParams = z.object({ videoId: z.uuid() });
const seenVideoUpdatedAt = z.iso.datetime().openapi({ description: "The `updatedAt` of the video as the reviewer saw it; a resend since then answers 409" });

const approveVideoRoute = authedRoute(
  {
    method: "post",
    path: "/v1/review/videos/{videoId}/approve",
    operationId: "approveVideo",
    tags: ["review"],
    summary: "Show a video on its spot",
    request: {
      params: videoParams,
      body: jsonBody(z.object({ seenUpdatedAt: seenVideoUpdatedAt })),
    },
    responses: videoDecisionResponses,
  },
  limitWrites("review"),
);

const rejectVideoRoute = authedRoute(
  {
    method: "post",
    path: "/v1/review/videos/{videoId}/reject",
    operationId: "rejectVideo",
    tags: ["review"],
    summary: "Turn a video down with a reason the submitter sees",
    request: {
      params: videoParams,
      body: jsonBody(z.object({ reason: VideoRejectReasonSchema, seenUpdatedAt: seenVideoUpdatedAt })),
    },
    responses: videoDecisionResponses,
  },
  limitWrites("review"),
);

const undoVideoRoute = authedRoute(
  {
    method: "post",
    path: "/v1/review/videos/{videoId}/undo",
    operationId: "undoVideoDecision",
    tags: ["review"],
    summary: "Take a video decision back",
    description:
      "The reviewer can undo their own decision for ten minutes; admins any time, which is also how a published video comes down. Undoing an approval takes the video off the spot. Retrying your own undo succeeds.",
    request: { params: videoParams },
    responses: videoDecisionResponses,
  },
  limitWrites("review"),
);

export const review = createRouter()
  .openapi(getReviewQueueRoute, async (c) => {
    const { cityId, limit } = c.req.valid("query");
    return c.json(success(await reviewQueue(c.var.database.db, c.var.user, cityId, limit)), 200);
  })
  .openapi(approveRoute, async (c) => {
    const { submissionId } = c.req.valid("param");
    const decided = await approveSubmission(c.var.database.db, c.var.user, submissionId, c.req.valid("json"));
    if (decided.isErr()) return respondError(c, decided.error);
    trackDecision(c, decided.value.kind === "edit_spot" ? "edit" : "spot", "approved", decided.value);
    findCityAfter(c, decided.value);
    await notifyAfter(c, (db) => reviewResultNotice(db, decided.value));
    return c.json(success(decided.value), 200);
  })
  .openapi(rejectRoute, async (c) => {
    const { submissionId } = c.req.valid("param");
    const decided = await rejectSubmission(c.var.database.db, c.var.user, submissionId, c.req.valid("json"));
    if (decided.isErr()) return respondError(c, decided.error);
    trackDecision(c, decided.value.kind === "edit_spot" ? "edit" : "spot", "rejected", decided.value);
    await notifyAfter(c, (db) => reviewResultNotice(db, decided.value));
    return c.json(success(decided.value), 200);
  })
  .openapi(undoRoute, async (c) => {
    const decided = await undoDecision(c.var.database.db, c.var.user, c.req.valid("param").submissionId);
    if (decided.isErr()) return respondError(c, decided.error);
    trackDecision(c, decided.value.kind === "edit_spot" ? "edit" : "spot", "undone", decided.value);
    return c.json(success(decided.value), 200);
  })
  .openapi(approveVideoRoute, async (c) => {
    const decided = await approveVideo(c.var.database.db, c.var.user, c.req.valid("param").videoId, c.req.valid("json"));
    if (decided.isErr()) return respondError(c, decided.error);
    trackDecision(c, "video", "approved", decided.value);
    await notifyAfter(c, (db) => videoResultNotice(db, decided.value));
    return c.json(success(decided.value), 200);
  })
  .openapi(rejectVideoRoute, async (c) => {
    const decided = await rejectVideo(c.var.database.db, c.var.user, c.req.valid("param").videoId, c.req.valid("json"));
    if (decided.isErr()) return respondError(c, decided.error);
    trackDecision(c, "video", "rejected", decided.value);
    await notifyAfter(c, (db) => videoResultNotice(db, decided.value));
    return c.json(success(decided.value), 200);
  })
  .openapi(undoVideoRoute, async (c) => {
    const decided = await undoVideoDecision(c.var.database.db, c.var.user, c.req.valid("param").videoId);
    if (decided.isErr()) return respondError(c, decided.error);
    trackDecision(c, "video", "undone", decided.value);
    return c.json(success(decided.value), 200);
  });

/** A repeated decision returns the row unchanged, so its `updatedAt` keeps it one event. */
function trackDecision(
  c: Context<AppEnv>,
  target: ServerEvents["submission_reviewed"]["target"],
  decision: ServerEvents["submission_reviewed"]["decision"],
  decided: { readonly id: string; readonly updatedAt: string },
): void {
  track(c, "submission_reviewed", { target, decision }, `${decided.id}:${decided.updatedAt}`);
}
