import type { RouteConfigToTypedResponse } from "@hono/zod-openapi";
import { errorResponses } from "../lib/errors.ts";
import { createRouter } from "../lib/openapi-app.ts";
import { publicRoute } from "../lib/routes.ts";
import { sharedText } from "../lib/shared-answer.ts";
import { CityBoundariesSchema } from "../lib/spot-schemas.ts";
import { withDatabase } from "../middleware/with-database.ts";
import { cityBoundaries } from "../services/cities.ts";

const BOUNDARIES_MAX_AGE_SECONDS = 86_400;

const getCityBoundariesRoute = publicRoute(
  {
    method: "get",
    path: "/v1/cities/boundaries",
    operationId: "getCityBoundaries",
    tags: ["spots"],
    summary: "Every city's boundary, as GeoJSON under the ODbL",
    description:
      "One GeoJSON Feature per city, shown in the apps or not yet, with its names and where it came from. The boundaries are © OpenStreetMap contributors, under the Open Database License (ODbL 1.0): credit OpenStreetMap, and share a database you make from them under the same licence. A plain GeoJSON FeatureCollection, not the API's envelope; errors still are. Cached for a day.",
    responses: {
      200: { description: "Every city's boundary", content: { "application/geo+json": { schema: CityBoundariesSchema } } },
      ...errorResponses,
    },
  },
  withDatabase,
);

export const cities = createRouter().openapi(getCityBoundariesRoute, async (c) => {
  const body = await sharedText(
    { key: new URL(c.req.path, c.req.url).href, seconds: BOUNDARIES_MAX_AGE_SECONDS, waitUntil: (promise) => c.executionCtx.waitUntil(promise) },
    async () => JSON.stringify(await cityBoundaries(c.var.database.db)),
  );
  const response = c.body(body, 200, {
    "Content-Type": "application/geo+json",
    "Content-Disposition": 'attachment; filename="openskatemap-city-boundaries.geojson"',
    "Cache-Control": `public, max-age=${BOUNDARIES_MAX_AGE_SECONDS}`,
    "Access-Control-Allow-Origin": "*",
  });
  // `body` is `CityBoundariesSchema`'s JSON, serialized here or kept by the edge cache; typed routes can't send ready text.
  return response as unknown as RouteConfigToTypedResponse<typeof getCityBoundariesRoute>;
});
