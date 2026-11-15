import { z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { success } from "../lib/envelope.ts";
import { createRouter } from "../lib/openapi-app.ts";
import { respondError } from "../lib/respond.ts";
import { answers, authedRoute } from "../lib/routes.ts";
import { PhotoUploadSchema } from "../lib/submission-schemas.ts";
import { limitWrites } from "../middleware/rate-limit.ts";
import { savePhoto } from "../services/photos.ts";

export const PHOTO_MAX_BYTES = 8 * 1024 * 1024;

const photoBodyLimit = bodyLimit({
  maxSize: PHOTO_MAX_BYTES,
  onError: (c) => respondError(c, { code: "validation_failed", message: "The photo is larger than 8 MB" }),
});

const uploadPhotoRoute = authedRoute({
  method: "put",
  path: "/v1/photos/{photoId}",
  operationId: "uploadPhoto",
  tags: ["contribute"],
  summary: "Upload one photo for a submission",
  description:
    "A JPEG with upright pixels (the server removes Exif, XMP and IPTC metadata, orientation included). The id is chosen by the app; uploading the same id again returns the photo stored the first time.",
  request: {
    params: z.object({ photoId: z.uuid() }),
    body: { required: true, content: { "image/jpeg": { schema: z.string().openapi({ format: "binary" }) } } },
  },
  responses: answers(PhotoUploadSchema, "UploadPhotoResponse", "The stored photo"),
}, limitWrites("contributions"), photoBodyLimit);

export const photos = createRouter().openapi(uploadPhotoRoute, async (c) => {
  if (c.req.header("content-type")?.split(";")[0]?.trim() !== "image/jpeg") {
    return respondError(c, { code: "validation_failed", message: "Send the photo as image/jpeg" });
  }
  const { photoId } = c.req.valid("param");
  const body = new Uint8Array(await c.req.arrayBuffer());
  const saved = await savePhoto(c.var.database.db, c.env.PHOTOS, c.var.user.id, photoId, body);
  if (saved.isErr()) return respondError(c, saved.error);
  return c.json(success(saved.value), 200);
});
