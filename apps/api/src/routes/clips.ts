import { z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { success } from "../lib/envelope.ts";
import { createRouter } from "../lib/openapi-app.ts";
import { respondError } from "../lib/respond.ts";
import { answers, authedRoute } from "../lib/routes.ts";
import { ClipUploadSchema } from "../lib/submission-schemas.ts";
import { limitWrites } from "../middleware/rate-limit.ts";
import { saveClip } from "../services/clips.ts";

export const CLIP_MAX_BYTES = 15 * 1024 * 1024;

const clipBodyLimit = bodyLimit({
  maxSize: CLIP_MAX_BYTES,
  onError: (c) => respondError(c, { code: "validation_failed", message: "The clip is larger than 15 MB" }),
});

const uploadClipRoute = authedRoute({
  method: "put",
  path: "/v1/clips/{clipId}",
  operationId: "uploadClip",
  tags: ["contribute"],
  summary: "Upload one short clip to play in place of a photo",
  description:
    "An MP4 with one silent H.264 video track, at most 16 s and 1920 px per side, its index (moov) before its media (faststart). The server keeps only what plays it (metadata and recording times are removed) and refuses sound or any other track. The id is chosen by the app; uploading the same id again returns the clip stored the first time.",
  request: {
    params: z.object({ clipId: z.uuid() }),
    body: { required: true, content: { "video/mp4": { schema: z.string().openapi({ format: "binary" }) } } },
  },
  responses: answers(ClipUploadSchema, "UploadClipResponse", "The stored clip"),
}, limitWrites("contributions"), clipBodyLimit);

export const clips = createRouter().openapi(uploadClipRoute, async (c) => {
  if (c.req.header("content-type")?.split(";")[0]?.trim() !== "video/mp4") {
    return respondError(c, { code: "validation_failed", message: "Send the clip as video/mp4" });
  }
  const { clipId } = c.req.valid("param");
  const body = new Uint8Array(await c.req.arrayBuffer());
  const saved = await saveClip(c.var.database.db, c.env.PHOTOS, c.var.user.id, clipId, body);
  if (saved.isErr()) return respondError(c, saved.error);
  return c.json(success(saved.value), 200);
});
