import { z } from "@hono/zod-openapi";
import type { Database } from "@openskatemap/db";
import type { CurrentUser } from "../env.ts";
import { success } from "../lib/envelope.ts";
import { createRouter } from "../lib/openapi-app.ts";
import { respondError } from "../lib/respond.ts";
import { answers, authedRoute, jsonBody } from "../lib/routes.ts";
import { NewSpotDraftSchema, SpotEditDraftSchema, type Submission, SubmissionSchema } from "../lib/submission-schemas.ts";
import { limitWrites } from "../middleware/rate-limit.ts";
import { findCityAfter } from "../services/city-places.ts";
import { notifyAfter, reviewQueueNotice } from "../services/notifications.ts";
import { approveSubmission } from "../services/review.ts";
import { saveSpotEdit } from "../services/spot-edits.ts";
import { mySubmissions, saveSubmission } from "../services/submissions.ts";
import { logFailure } from "../lib/log.ts";
import { track } from "../lib/posthog.ts";

const saveSubmissionRoute = authedRoute({
  method: "put",
  path: "/v1/submissions/{submissionId}",
  operationId: "saveSubmission",
  tags: ["contribute"],
  summary: "Send a new spot for review",
  description:
    "An admin's spot is published at once (answered as approved, by its author). The id is the app's outbox id: send the same id on every retry and the server keeps one submission. While it is pending, sending it again replaces it; once a curator has decided, it returns the decision unchanged. Upload the photos first; a 422 lists `missingPhotos` in its details.",
  request: {
    params: z.object({ submissionId: z.uuid() }),
    body: jsonBody(NewSpotDraftSchema),
  },
  responses: answers(SubmissionSchema, "SaveSubmissionResponse", "The submission as stored"),
}, limitWrites("contributions"));

const saveSpotEditRoute = authedRoute({
  method: "put",
  path: "/v1/spot-edits/{submissionId}",
  operationId: "saveSpotEdit",
  tags: ["contribute"],
  summary: "Edit a published spot, or suggest an edit to it",
  description:
    "Only what differs from the spot counts; with nothing left it answers 422. An admin's edit applies at once (answered as approved, by its author); anyone else's waits for review. Same id rules as `saveSubmission`: send the same id on every retry; a pending edit is replaced, a decided one returns unchanged. Upload added photos first; a 422 lists `missingPhotos`. A private, removed or unknown spot answers 404.",
  request: {
    params: z.object({ submissionId: z.uuid() }),
    body: jsonBody(SpotEditDraftSchema),
  },
  responses: answers(SubmissionSchema, "SaveSpotEditResponse", "The edit as stored, a submission of kind `edit_spot`"),
}, limitWrites("contributions"));

const getMySubmissionsRoute = authedRoute({
  method: "get",
  path: "/v1/me/submissions",
  operationId: "getMySubmissions",
  tags: ["contribute"],
  summary: "Your submissions and what curators decided",
  description: "Newest first, at most 200. A decided submission whose spot an admin took down is left out.",
  responses: answers(z.object({ submissions: z.array(SubmissionSchema) }), "GetMySubmissionsResponse", "Your submissions"),
});

async function approvedByAdmin(db: Database, user: CurrentUser, saved: Submission): Promise<Submission | undefined> {
  if (user.role !== "admin" || saved.status !== "pending") return undefined;
  const approved = await approveSubmission(db, user, saved.id, { edits: {}, seenUpdatedAt: saved.updatedAt, wholePhotoList: true });
  if (approved.isOk()) return approved.value;
  logFailure("An admin's submission stayed pending", approved.error);
  return undefined;
}

export const submissions = createRouter()
  .openapi(saveSubmissionRoute, async (c) => {
    const { submissionId } = c.req.valid("param");
    const { db } = c.var.database;
    const saved = await saveSubmission(db, c.var.user.id, submissionId, c.req.valid("json"));
    if (saved.isErr()) return respondError(c, saved.error);
    const spot = (await approvedByAdmin(db, c.var.user, saved.value)) ?? saved.value;
    track(c, "spot_submitted", { private: spot.collectionId !== null, photos: spot.photos.length }, spot.id);
    findCityAfter(c, spot);
    await notifyAfter(c, (db) => reviewQueueNotice(db, spot, c.var.user.id));
    return c.json(success(spot), 200);
  })
  .openapi(saveSpotEditRoute, async (c) => {
    const { submissionId } = c.req.valid("param");
    const { db } = c.var.database;
    const saved = await saveSpotEdit(db, c.var.user.id, submissionId, c.req.valid("json"));
    if (saved.isErr()) return respondError(c, saved.error);
    const applied = await approvedByAdmin(db, c.var.user, saved.value);
    const edit = applied ?? saved.value;
    track(c, applied ? "spot_edited" : "edit_suggested", { photos: edit.photos.filter((photo) => !photo.existing).length }, edit.id);
    findCityAfter(c, edit);
    await notifyAfter(c, (db) => reviewQueueNotice(db, edit, c.var.user.id));
    return c.json(success(edit), 200);
  })
  .openapi(getMySubmissionsRoute, async (c) =>
    c.json(success({ submissions: await mySubmissions(c.var.database.db, c.var.user.id) }), 200),
  );
