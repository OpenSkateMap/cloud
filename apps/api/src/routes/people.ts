import { z } from "@hono/zod-openapi";
import { success } from "../lib/envelope.ts";
import { createRouter } from "../lib/openapi-app.ts";
import { BlockedUserSchema, ProfileUpdateSchema, PublicProfileSchema, ReportInputSchema } from "../lib/people-schemas.ts";
import { respondError } from "../lib/respond.ts";
import { answers, authedRoute, jsonBody } from "../lib/routes.ts";
import { IdSchema } from "../lib/spot-schemas.ts";
import { limitWrites } from "../middleware/rate-limit.ts";
import { blockedUsers, blockUser, fileReport, publicProfile, unblockUser, updateProfile } from "../services/people.ts";
import { track } from "../lib/posthog.ts";

const profileResponse = (name: string) => answers(PublicProfileSchema, name, "The profile as others see it");
const userParams = z.object({ userId: IdSchema });
const blockResponse = answers(z.object({ blocked: z.boolean() }), "BlockResponse", "Whether you block this person now");

const getUserProfileRoute = authedRoute({
  method: "get",
  path: "/v1/users/{userId}",
  operationId: "getUserProfile",
  tags: ["people"],
  summary: "A person's public profile",
  description: "Name, username, bio, handles, role, cities they review and contribution stats. Never an email.",
  request: { params: userParams },
  responses: profileResponse("GetUserProfileResponse"),
});

const updateMyProfileRoute = authedRoute(
  {
    method: "patch",
    path: "/v1/me/profile",
    operationId: "updateMyProfile",
    tags: ["people"],
    summary: "Change your profile",
    description: "A username keeps its case. One someone else holds in any case, or one that isn't allowed (slurs, swearing, our own names, companies' names), answers 409. An avatar is a photo you uploaded with PUT /v1/photos/{photoId}.",
    request: { body: jsonBody(ProfileUpdateSchema) },
    responses: profileResponse("UpdateMyProfileResponse"),
  },
  limitWrites("profile"),
);

const createReportRoute = authedRoute(
  {
    method: "post",
    path: "/v1/reports",
    operationId: "createReport",
    tags: ["people"],
    summary: "Report a spot or a person to the admins",
    request: { body: jsonBody(ReportInputSchema) },
    responses: answers(z.object({ id: z.string() }), "CreateReportResponse", "The report was filed"),
  },
  limitWrites("outreach"),
);

const listBlocksRoute = authedRoute({
  method: "get",
  path: "/v1/me/blocks",
  operationId: "listBlockedUsers",
  tags: ["people"],
  summary: "People you blocked",
  responses: answers(z.object({ users: z.array(BlockedUserSchema) }), "ListBlockedUsersResponse", "Most recent first"),
});

const blockRoute = authedRoute(
  {
    method: "put",
    path: "/v1/me/blocks/{userId}",
    operationId: "blockUser",
    tags: ["people"],
    summary: "Block a person",
    description: "Their name no longer shows on spots you open, and they can no longer see your profile.",
    request: { params: userParams },
    responses: blockResponse,
  },
  limitWrites("profile"),
);

const unblockRoute = authedRoute(
  {
    method: "delete",
    path: "/v1/me/blocks/{userId}",
    operationId: "unblockUser",
    tags: ["people"],
    summary: "Unblock a person",
    request: { params: userParams },
    responses: blockResponse,
  },
  limitWrites("profile"),
);

export const people = createRouter()
  .openapi(getUserProfileRoute, async (c) => {
    const found = await publicProfile(c.var.database.db, c.var.user.id, c.req.valid("param").userId);
    if (found.isErr()) return respondError(c, found.error);
    return c.json(success(found.value), 200);
  })
  .openapi(updateMyProfileRoute, async (c) => {
    const updated = await updateProfile(c.var.database.db, c.var.user.id, c.req.valid("json"));
    if (updated.isErr()) return respondError(c, updated.error);
    return c.json(success(updated.value), 200);
  })
  .openapi(createReportRoute, async (c) => {
    const filed = await fileReport(c.var.database.db, c.var.user.id, c.req.valid("json"));
    if (filed.isErr()) return respondError(c, filed.error);
    track(c, "report_sent", { target: c.req.valid("json").targetKind });
    return c.json(success(filed.value), 200);
  })
  .openapi(listBlocksRoute, async (c) => c.json(success({ users: await blockedUsers(c.var.database.db, c.var.user.id) }), 200))
  .openapi(blockRoute, async (c) => {
    const blocked = await blockUser(c.var.database.db, c.var.user.id, c.req.valid("param").userId);
    if (blocked.isErr()) return respondError(c, blocked.error);
    return c.json(success(blocked.value), 200);
  })
  .openapi(unblockRoute, async (c) => c.json(success(await unblockUser(c.var.database.db, c.var.user.id, c.req.valid("param").userId)), 200));
