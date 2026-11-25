import { z } from "@hono/zod-openapi";
import { success } from "../lib/envelope.ts";
import { createRouter } from "../lib/openapi-app.ts";
import { queryNumber } from "../lib/query.ts";
import { track } from "../lib/posthog.ts";
import { respondError } from "../lib/respond.ts";
import { answers, authedRoute, jsonBody } from "../lib/routes.ts";
import {
  CitySchema,
  IdSchema,
  NearbySpotSchema,
  SpotDetailsSchema,
  SpotIndexRowSchema,
  SpotRemovalReasonSchema,
  SpotRemovalSchema,
  SyncPageSchema,
} from "../lib/spot-schemas.ts";
import { limitWrites } from "../middleware/rate-limit.ts";
import { requireRole } from "../middleware/require-role.ts";
import { restoreSpot, takeDownSpot } from "../services/curation.ts";
import { searchSpots } from "../services/spot-search.ts";
import { listCities, nearbySpots, spotDetails, syncSpots } from "../services/spots.ts";

const SYNC_PAGE = 500;

const syncSpotsRoute = authedRoute({
  method: "get",
  path: "/v1/sync/spots",
  operationId: "syncSpots",
  tags: ["spots"],
  summary: "Spots changed since a cursor",
  description:
    "Start at cursor 0 and keep the returned `nextCursor`. Apply each page (upserts, then tombstones, then the cursor) in one local transaction, and ask again right away while `hasMore` is true.",
  request: {
    query: z.object({
      cursor: queryNumber({ min: 0, max: Number.MAX_SAFE_INTEGER, integer: true }).default(0),
      limit: queryNumber({ min: 1, max: SYNC_PAGE, integer: true }).default(SYNC_PAGE),
    }),
  },
  responses: answers(SyncPageSchema, "SyncSpotsResponse", "One page of changes"),
});

const getSpotsRoute = authedRoute({
  method: "get",
  path: "/v1/spots",
  operationId: "getSpots",
  tags: ["spots"],
  summary: "Spot details by id",
  description: "The heavy part of a spot (description, obstacles, photos), fetched for the spots on screen.",
  request: {
    query: z.object({
      ids: z
        .string()
        .transform((ids) => [...new Set(ids.split(","))])
        .pipe(z.array(IdSchema).min(1).max(100))
        .openapi({ description: "Up to 100 comma-separated spot ids", example: "a1,b2" }),
    }),
  },
  responses: answers(SpotDetailsSchema, "GetSpotsResponse", "The published spots among the ids, and the ids that are not"),
});

const getNearbySpotsRoute = authedRoute({
  method: "get",
  path: "/v1/spots/nearby",
  operationId: "getNearbySpots",
  tags: ["spots"],
  summary: "Published spots near a point",
  description: "Nearest first, at most 50. Used to catch duplicates before a spot is submitted.",
  request: {
    query: z.object({
      latitude: queryNumber({ min: -90, max: 90 }),
      longitude: queryNumber({ min: -180, max: 180 }),
      radiusMeters: queryNumber({ min: 1, max: 2000, integer: true }).default(150),
    }),
  },
  responses: answers(z.object({ spots: z.array(NearbySpotSchema) }), "GetNearbySpotsResponse", "Spots within the radius"),
});

const searchSpotsRoute = authedRoute({
  method: "get",
  path: "/v1/spots/search",
  operationId: "searchSpots",
  tags: ["spots"],
  summary: "Published spots by name",
  description:
    "For spots the local index doesn't have yet (a sync still running); rows are what the sync sends. Names are compared in Latin letters (Cyrillic romanised, so `novokrest` finds Новокрестовская), ignoring case and accents, with ё as е and й as и or y. First spots where every word of `q` starts a word of the name or of its city's name; then names containing every word; then, to fill `limit`, names with a word one letter off (two from 8 letters) for words of 5 letters or more. Within each, nearest to `latitude`/`longitude` first when given, then by name.",
  request: {
    query: z
      .object({
        q: z.string().trim().min(1).max(100).openapi({ description: "What the rider typed", example: "novokrest" }),
        latitude: queryNumber({ min: -90, max: 90 }).optional().openapi({ description: "With `longitude`: the map's centre, which breaks ties" }),
        longitude: queryNumber({ min: -180, max: 180 }).optional(),
        limit: queryNumber({ min: 1, max: 50, integer: true }).default(20),
      })
      .refine(({ latitude, longitude }) => (latitude === undefined) === (longitude === undefined), "Send both latitude and longitude, or neither"),
  },
  responses: answers(z.object({ spots: z.array(SpotIndexRowSchema) }), "SearchSpotsResponse", "The best matches first, at most `limit`"),
});

const getCitiesRoute = authedRoute({
  method: "get",
  path: "/v1/cities",
  operationId: "getCities",
  tags: ["spots"],
  summary: "Every city with curated spots",
  responses: answers(z.object({ cities: z.array(CitySchema) }), "GetCitiesResponse", "All cities, by name"),
});

const spotParams = z.object({ spotId: IdSchema });

const takeDownSpotRoute = authedRoute(
  {
    method: "put",
    path: "/v1/spots/{spotId}/removal",
    operationId: "takeDownSpot",
    tags: ["spots"],
    summary: "Take a spot off the map",
    description:
      "Admins only, public or private spots. The spot is marked removed, never deleted: the sync sends it as a tombstone, details and collections stop returning it, and its submitter's history shows it removed with the reason. Taking down a taken-down spot changes nothing and answers its first removal.",
    request: { params: spotParams, body: jsonBody(z.object({ reason: SpotRemovalReasonSchema })) },
    responses: answers(SpotRemovalSchema, "TakeDownSpotResponse", "The spot's removal"),
  },
  requireRole(),
  limitWrites("review"),
);

const restoreSpotRoute = authedRoute(
  {
    method: "delete",
    path: "/v1/spots/{spotId}/removal",
    operationId: "restoreSpot",
    tags: ["spots"],
    summary: "Put a taken-down spot back on the map",
    description:
      "Admins only. Undoes a takedown: the spot is published again under a new version, so the sync brings it back. Restoring a published spot changes nothing; a spot removed by an undone approval is a 409.",
    request: { params: spotParams },
    responses: answers(z.object({ restored: z.literal(true) }), "RestoreSpotResponse", "The spot is back on the map"),
  },
  requireRole(),
  limitWrites("review"),
);

export const spots = createRouter()
  .openapi(syncSpotsRoute, async (c) => {
    const { cursor, limit } = c.req.valid("query");
    return c.json(success(await syncSpots(c.var.database.db, cursor, limit)), 200);
  })
  .openapi(getNearbySpotsRoute, async (c) => {
    const { latitude, longitude, radiusMeters } = c.req.valid("query");
    return c.json(success({ spots: await nearbySpots(c.var.database.db, latitude, longitude, radiusMeters) }), 200);
  })
  .openapi(searchSpotsRoute, async (c) => {
    const { q, latitude, longitude, limit } = c.req.valid("query");
    const near = latitude === undefined || longitude === undefined ? undefined : { latitude, longitude };
    return c.json(success({ spots: await searchSpots(c.var.database.db, { query: q, limit, near }) }), 200);
  })
  .openapi(getSpotsRoute, async (c) => {
    const { ids } = c.req.valid("query");
    return c.json(success(await spotDetails(c.var.database.db, c.var.user.id, ids)), 200);
  })
  .openapi(getCitiesRoute, async (c) => c.json(success({ cities: await listCities(c.var.database.db) }), 200))
  .openapi(takeDownSpotRoute, async (c) => {
    const { reason } = c.req.valid("json");
    const removed = await takeDownSpot(c.var.database.db, c.var.user, c.req.valid("param").spotId, reason);
    if (removed.isErr()) return respondError(c, removed.error);
    const { removal, eventId, isPrivate } = removed.value;
    if (eventId !== undefined) track(c, "spot_removed", { private: isPrivate, reason: removal.reason }, String(eventId));
    return c.json(success(removal), 200);
  })
  .openapi(restoreSpotRoute, async (c) => {
    const restored = await restoreSpot(c.var.database.db, c.var.user, c.req.valid("param").spotId);
    if (restored.isErr()) return respondError(c, restored.error);
    const { eventId, isPrivate } = restored.value;
    if (eventId !== undefined) track(c, "spot_restored", { private: isPrivate }, String(eventId));
    return c.json(success({ restored: true as const }), 200);
  });
