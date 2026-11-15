import { z } from "@hono/zod-openapi";
import { success } from "../lib/envelope.ts";
import { createRouter } from "../lib/openapi-app.ts";
import { respondError } from "../lib/respond.ts";
import { answers, authedRoute, jsonBody } from "../lib/routes.ts";
import { IdSchema } from "../lib/spot-schemas.ts";
import { VideoDraftSchema, VideoSubmissionSchema } from "../lib/video-schemas.ts";
import { limitWrites } from "../middleware/rate-limit.ts";
import { notifyAfter, videoQueueNotice } from "../services/notifications.ts";
import { saveVideo } from "../services/videos.ts";
import { track } from "../lib/posthog.ts";

const saveVideoRoute = authedRoute(
  {
    method: "put",
    path: "/v1/spots/{spotId}/videos/{videoId}",
    operationId: "saveVideo",
    tags: ["contribute"],
    summary: "Send a YouTube or Instagram video of a spot for review",
    description:
      "The id is the app's outbox id: send the same id on every retry and the server keeps one video. While it is pending, sending it again replaces the link and caption; once a curator has decided, it returns the decision unchanged. A link that isn't a YouTube video or an Instagram post or reel, or a new YouTube video that no longer plays there (private or removed, per YouTube's oEmbed), is a 422; the same clip already waiting or shown on the spot is a 409.",
    request: {
      params: z.object({ spotId: IdSchema, videoId: z.uuid() }),
      body: jsonBody(VideoDraftSchema),
    },
    responses: answers(VideoSubmissionSchema, "SaveVideoResponse", "The video as stored"),
  },
  limitWrites("contributions"),
);

export const videos = createRouter().openapi(saveVideoRoute, async (c) => {
  const { spotId, videoId } = c.req.valid("param");
  const saved = await saveVideo(c.var.database.db, c.var.user.id, spotId, videoId, c.req.valid("json"));
  if (saved.isErr()) return respondError(c, saved.error);
  track(c, "video_submitted", { provider: saved.value.provider }, saved.value.id);
  await notifyAfter(c, (db) => videoQueueNotice(db, saved.value, c.var.user.id));
  return c.json(success(saved.value), 200);
});
