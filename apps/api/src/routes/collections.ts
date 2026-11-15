import { z } from "@hono/zod-openapi";
import {
  CollectionAccessSchema,
  CollectionDraftSchema,
  CollectionInviteDraftSchema,
  CollectionMemberDraftSchema,
  CollectionPageSchema,
  CollectionRequestAnswerSchema,
  CollectionSchema,
  CollectionSpotsPageSchema,
  CollectionsSnapshotSchema,
} from "../lib/collection-schemas.ts";
import { pageQuery } from "../lib/paging.ts";
import { success } from "../lib/envelope.ts";
import { createRouter } from "../lib/openapi-app.ts";
import { reply, respondError } from "../lib/respond.ts";
import { answers, authedRoute, jsonBody } from "../lib/routes.ts";
import { IdSchema } from "../lib/spot-schemas.ts";
import { limitWrites } from "../middleware/rate-limit.ts";
import {
  acceptInvitation,
  addSpot,
  approveRequest,
  cancelInvite,
  collectionAccess,
  collectionManagers,
  COLLECTION_SPOTS_PAGE,
  collectionPage,
  collectionSpots,
  collectionSpotsKey,
  collectionsSnapshot,
  declineInvitation,
  declineRequest,
  deleteCollection,
  favorite,
  invite,
  removeMember,
  removeSpot,
  requestAccess,
  saveCollection,
  setMemberRole,
  userCollections,
} from "../services/collections.ts";
import { collectionInvitationNotice, collectionJoinedNotice, collectionRequestNotice, notifyAfter } from "../services/notifications.ts";
import { track } from "../lib/posthog.ts";

const collectionParams = z.object({ collectionId: z.uuid() });
const spotParams = z.object({ collectionId: z.uuid(), spotId: IdSchema });
const personParams = z.object({ collectionId: z.uuid(), userId: IdSchema });

const getMyCollectionsRoute = authedRoute({
  method: "get",
  path: "/v1/me/collections",
  operationId: "getMyCollections",
  tags: ["collections"],
  summary: "Your collections, the ones shared with you, and their private spots",
  description:
    "One snapshot to cache whole. Email invites to your account's email become your invitations first. A private spot the app has that isn't in `privateSpots` is one you can no longer see.",
  responses: answers(CollectionsSnapshotSchema, "GetMyCollectionsResponse", "Everything the app caches for collections"),
});

const saveCollectionRoute = authedRoute(
  {
    method: "put",
    path: "/v1/collections/{collectionId}",
    operationId: "saveCollection",
    tags: ["collections"],
    summary: "Create a collection, or change one you edit",
    description:
      "The id is the app's: a retry lands on the same collection. Editors change the name and description; the owner and admins also the visibility. A collection you can open but not edit is a 403, one you can't open a 404, so a private one's id never confirms it exists.",
    request: { params: collectionParams, body: jsonBody(CollectionDraftSchema) },
    responses: answers(CollectionSchema, "SaveCollectionResponse", "The collection as stored"),
  },
  limitWrites("collections"),
);

const deleteCollectionRoute = authedRoute(
  {
    method: "delete",
    path: "/v1/collections/{collectionId}",
    operationId: "deleteCollection",
    tags: ["collections"],
    summary: "Delete a collection",
    description: "The owner and admins. Its people lose access; private spots in it stay their makers'.",
    request: { params: collectionParams },
    responses: answers(z.object({ deleted: z.literal(true) }), "DeleteCollectionResponse", "It's gone"),
  },
  limitWrites("collections"),
);

const getCollectionRoute = authedRoute({
  method: "get",
  path: "/v1/collections/{collectionId}",
  operationId: "getCollection",
  tags: ["collections"],
  summary: "A collection and its spots",
  description: "Yours, one shared with you, or a public one by its link. Anything else is a 404.",
  request: { params: collectionParams },
  responses: answers(CollectionPageSchema, "GetCollectionResponse", "The collection with its spots as the map indexes them"),
});

const getCollectionSpotsRoute = authedRoute({
  method: "get",
  path: "/v1/collections/{collectionId}/spots",
  operationId: "getCollectionSpots",
  tags: ["collections"],
  summary: "A collection's spots, a page at a time",
  description:
    "In `spotIds` order. Start with the `nextCursor` of `GET /v1/collections/{collectionId}` and keep sending the one each page returns until it's null. Who may open the collection is as for that call: anyone else gets a 404.",
  request: { params: collectionParams, query: pageQuery({ key: collectionSpotsKey, ...COLLECTION_SPOTS_PAGE }) },
  responses: answers(CollectionSpotsPageSchema, "GetCollectionSpotsResponse", "One page of the collection's spots"),
});

const addSpotRoute = authedRoute(
  {
    method: "put",
    path: "/v1/collections/{collectionId}/spots/{spotId}",
    operationId: "addSpotToCollection",
    tags: ["collections"],
    summary: "Add a spot to a collection you edit",
    description: "Any public spot, or a private spot you made. Adding it again changes nothing.",
    request: { params: spotParams },
    responses: answers(CollectionSchema, "AddSpotToCollectionResponse", "The collection after it"),
  },
  limitWrites("collections"),
);

const removeSpotRoute = authedRoute(
  {
    method: "delete",
    path: "/v1/collections/{collectionId}/spots/{spotId}",
    operationId: "removeSpotFromCollection",
    tags: ["collections"],
    summary: "Take a spot out of a collection you edit",
    request: { params: spotParams },
    responses: answers(CollectionSchema, "RemoveSpotFromCollectionResponse", "The collection after it"),
  },
  limitWrites("collections"),
);

const getAccessRoute = authedRoute({
  method: "get",
  path: "/v1/collections/{collectionId}/access",
  operationId: "getCollectionAccess",
  tags: ["collections"],
  summary: "Who's in a collection",
  description: "Its visibility, owner and members with their roles, for anyone in it. The owner and admins also get the invites waiting for an answer and the requests to join.",
  request: { params: collectionParams },
  responses: answers(CollectionAccessSchema, "GetCollectionAccessResponse", "The collection's access"),
});

const shareRoute = authedRoute(
  {
    method: "post",
    path: "/v1/collections/{collectionId}/access",
    operationId: "shareCollection",
    tags: ["collections"],
    summary: "Invite someone to a collection",
    description:
      "The owner and admins, with a role. By @username (an unknown one is a 404) or by the email they signed in with; either way they accept or decline, and someone who asked to join is let in at once. An email gets the same answer whether or not anyone uses it.",
    request: { params: collectionParams, body: jsonBody(CollectionInviteDraftSchema) },
    responses: answers(CollectionAccessSchema, "ShareCollectionResponse", "The collection's access after it"),
  },
  limitWrites("outreach"),
);

const removeMemberRoute = authedRoute(
  {
    method: "delete",
    path: "/v1/collections/{collectionId}/members/{userId}",
    operationId: "removeCollectionMember",
    tags: ["collections"],
    summary: "Take someone off a collection, or leave one",
    description: "The owner and admins take anyone off; anyone can leave.",
    request: { params: personParams },
    responses: answers(z.object({ removed: z.literal(true) }), "RemoveCollectionMemberResponse", "They no longer see it"),
  },
  limitWrites("collections"),
);

const cancelInviteRoute = authedRoute(
  {
    method: "delete",
    path: "/v1/collections/{collectionId}/invites/{inviteId}",
    operationId: "cancelCollectionInvite",
    tags: ["collections"],
    summary: "Cancel an invite",
    request: { params: z.object({ collectionId: z.uuid(), inviteId: IdSchema }) },
    responses: answers(CollectionAccessSchema, "CancelCollectionInviteResponse", "The collection's access after it"),
  },
  limitWrites("collections"),
);

const setMemberRoleRoute = authedRoute(
  {
    method: "put",
    path: "/v1/collections/{collectionId}/members/{userId}",
    operationId: "setCollectionMemberRole",
    tags: ["collections"],
    summary: "Change someone's role in a collection",
    description: "The owner and admins.",
    request: { params: personParams, body: jsonBody(CollectionMemberDraftSchema) },
    responses: answers(CollectionAccessSchema, "SetCollectionMemberRoleResponse", "The collection's access after it"),
  },
  limitWrites("collections"),
);

const acceptInvitationRoute = authedRoute(
  {
    method: "post",
    path: "/v1/collections/{collectionId}/invitation/accept",
    operationId: "acceptCollectionInvitation",
    tags: ["collections"],
    summary: "Accept your invitation to a collection",
    description: "You join with the role it offered. Accepting again answers the same.",
    request: { params: collectionParams },
    responses: answers(CollectionSchema, "AcceptCollectionInvitationResponse", "The collection you're now in"),
  },
  limitWrites("collections"),
);

const declineInvitationRoute = authedRoute(
  {
    method: "post",
    path: "/v1/collections/{collectionId}/invitation/decline",
    operationId: "declineCollectionInvitation",
    tags: ["collections"],
    summary: "Decline your invitation to a collection",
    request: { params: collectionParams },
    responses: answers(z.object({ declined: z.literal(true) }), "DeclineCollectionInvitationResponse", "It's gone"),
  },
  limitWrites("collections"),
);

const requestAccessRoute = authedRoute(
  {
    method: "post",
    path: "/v1/collections/{collectionId}/requests",
    operationId: "requestCollectionAccess",
    tags: ["collections"],
    summary: "Ask to join a collection you have the link to",
    description:
      "The owner and admins answer. The same answer whether or not the collection exists, so a link never confirms a private one; asking again changes nothing.",
    request: { params: collectionParams },
    responses: answers(z.object({ requested: z.literal(true) }), "RequestCollectionAccessResponse", "Asked"),
  },
  limitWrites("outreach"),
);

const approveRequestRoute = authedRoute(
  {
    method: "post",
    path: "/v1/collections/{collectionId}/requests/{userId}/approve",
    operationId: "approveCollectionRequest",
    tags: ["collections"],
    summary: "Let someone who asked into a collection",
    description: "The owner and admins, with a role (viewer unless you say).",
    request: { params: personParams, body: jsonBody(CollectionRequestAnswerSchema) },
    responses: answers(CollectionAccessSchema, "ApproveCollectionRequestResponse", "The collection's access after it"),
  },
  limitWrites("collections"),
);

const declineRequestRoute = authedRoute(
  {
    method: "delete",
    path: "/v1/collections/{collectionId}/requests/{userId}",
    operationId: "declineCollectionRequest",
    tags: ["collections"],
    summary: "Turn down a request to join a collection",
    description: "The owner and admins. They aren't told.",
    request: { params: personParams },
    responses: answers(CollectionAccessSchema, "DeclineCollectionRequestResponse", "The collection's access after it"),
  },
  limitWrites("collections"),
);

const favoriteParams = z.object({ spotId: IdSchema });

const starRoute = authedRoute(
  {
    method: "put",
    path: "/v1/me/favorites/{spotId}",
    operationId: "starSpot",
    tags: ["collections"],
    summary: "Star a spot: it goes into your Favorites",
    description: "Any public spot, or a private one you made. Starring it again changes nothing.",
    request: { params: favoriteParams },
    responses: answers(CollectionSchema, "StarSpotResponse", "Your Favorites after it"),
  },
  limitWrites("collections"),
);

const unstarRoute = authedRoute(
  {
    method: "delete",
    path: "/v1/me/favorites/{spotId}",
    operationId: "unstarSpot",
    tags: ["collections"],
    summary: "Take a spot out of your Favorites",
    request: { params: favoriteParams },
    responses: answers(CollectionSchema, "UnstarSpotResponse", "Your Favorites after it"),
  },
  limitWrites("collections"),
);

const getUserCollectionsRoute = authedRoute({
  method: "get",
  path: "/v1/users/{userId}/collections",
  operationId: "getUserCollections",
  tags: ["collections"],
  summary: "Someone's public collections",
  description: "Newest first. A 404 when they blocked you, as for their profile.",
  request: { params: z.object({ userId: IdSchema }) },
  responses: answers(z.object({ collections: z.array(CollectionSchema) }), "GetUserCollectionsResponse", "Their public collections"),
});

export const collections = createRouter()
  .openapi(getMyCollectionsRoute, async (c) => c.json(success(await collectionsSnapshot(c.var.database.db, c.var.user)), 200))
  .openapi(saveCollectionRoute, async (c) => reply(c, await saveCollection(c.var.database.db, c.var.user.id, c.req.valid("param").collectionId, c.req.valid("json"))))
  .openapi(deleteCollectionRoute, async (c) => reply(c, await deleteCollection(c.var.database.db, c.var.user.id, c.req.valid("param").collectionId)))
  .openapi(getCollectionRoute, async (c) => reply(c, await collectionPage(c.var.database.db, c.var.user.id, c.req.valid("param").collectionId)))
  .openapi(getCollectionSpotsRoute, async (c) => reply(c, await collectionSpots(c.var.database.db, c.var.user.id, c.req.valid("param").collectionId, c.req.valid("query"))))
  .openapi(addSpotRoute, async (c) => {
    const { collectionId, spotId } = c.req.valid("param");
    return reply(c, await addSpot(c.var.database.db, c.var.user.id, collectionId, spotId));
  })
  .openapi(removeSpotRoute, async (c) => {
    const { collectionId, spotId } = c.req.valid("param");
    return reply(c, await removeSpot(c.var.database.db, c.var.user.id, collectionId, spotId));
  })
  .openapi(getAccessRoute, async (c) => reply(c, await collectionAccess(c.var.database.db, c.var.user.id, c.req.valid("param").collectionId)))
  .openapi(shareRoute, async (c) => {
    const { collectionId } = c.req.valid("param");
    const draft = c.req.valid("json");
    const shared = await invite(c.var.database.db, c.var.user, collectionId, draft);
    if (shared.isErr()) return respondError(c, shared.error);
    const { access, invited } = shared.value;
    if (invited) {
      const once = `${invited.kind === "added" ? `${collectionId}:${invited.userId}` : invited.inviteId}:${draft.role}`;
      track(c, "collection_shared", { via: draft.username === undefined ? "email" : "username", role: draft.role }, once);
    }
    if (invited?.kind === "invited") await notifyAfter(c, (db) => collectionInvitationNotice(db, c.var.user, collectionId, invited));
    if (invited?.kind === "added") await notifyAfter(c, (db) => collectionJoinedNotice(db, c.var.user, collectionId, invited.userId));
    return c.json(success(access), 200);
  })
  .openapi(removeMemberRoute, async (c) => {
    const { collectionId, userId } = c.req.valid("param");
    return reply(c, await removeMember(c.var.database.db, c.var.user.id, collectionId, userId));
  })
  .openapi(cancelInviteRoute, async (c) => {
    const { collectionId, inviteId } = c.req.valid("param");
    return reply(c, await cancelInvite(c.var.database.db, c.var.user.id, collectionId, inviteId));
  })
  .openapi(setMemberRoleRoute, async (c) => {
    const { collectionId, userId } = c.req.valid("param");
    return reply(c, await setMemberRole(c.var.database.db, c.var.user.id, collectionId, userId, c.req.valid("json").role));
  })
  .openapi(acceptInvitationRoute, async (c) => {
    const joined = await acceptInvitation(c.var.database.db, c.var.user.id, c.req.valid("param").collectionId);
    if (joined.isErr()) return respondError(c, joined.error);
    track(c, "collection_joined", {}, `${c.req.valid("param").collectionId}:${c.var.user.id}`);
    return c.json(success(joined.value), 200);
  })
  .openapi(declineInvitationRoute, async (c) => reply(c, await declineInvitation(c.var.database.db, c.var.user.id, c.req.valid("param").collectionId)))
  .openapi(requestAccessRoute, async (c) => {
    const { collectionId } = c.req.valid("param");
    const { requested, newRequest } = await requestAccess(c.var.database.db, c.var.user.id, collectionId);
    if (newRequest !== null) {
      track(c, "collection_access_requested", {});
      await notifyAfter(c, async (db) =>
        collectionRequestNotice(c.var.user, collectionId, { name: newRequest.name, managers: await collectionManagers(db, collectionId) }),
      );
    }
    return c.json(success({ requested }), 200);
  })
  .openapi(approveRequestRoute, async (c) => {
    const { collectionId, userId } = c.req.valid("param");
    const access = await approveRequest(c.var.database.db, c.var.user.id, collectionId, userId, c.req.valid("json").role);
    if (access.isErr()) return respondError(c, access.error);
    track(c, "collection_request_approved", { role: c.req.valid("json").role });
    await notifyAfter(c, (db) => collectionJoinedNotice(db, c.var.user, collectionId, userId));
    return c.json(success(access.value), 200);
  })
  .openapi(declineRequestRoute, async (c) => {
    const { collectionId, userId } = c.req.valid("param");
    return reply(c, await declineRequest(c.var.database.db, c.var.user.id, collectionId, userId));
  })
  .openapi(starRoute, async (c) => reply(c, await favorite(c.var.database.db, c.var.user.id, c.req.valid("param").spotId, true)))
  .openapi(unstarRoute, async (c) => reply(c, await favorite(c.var.database.db, c.var.user.id, c.req.valid("param").spotId, false)))
  .openapi(getUserCollectionsRoute, async (c) => {
    const found = await userCollections(c.var.database.db, c.var.user.id, c.req.valid("param").userId);
    return found.isErr() ? respondError(c, found.error) : c.json(success({ collections: found.value }), 200);
  });
