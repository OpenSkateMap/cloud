import { z } from "@hono/zod-openapi";
import { success } from "../lib/envelope.ts";
import { answers, publicRoute } from "../lib/routes.ts";
import { createRouter } from "../lib/openapi-app.ts";
import { respondError } from "../lib/respond.ts";
import { IdSchema, SpotCardSchema } from "../lib/spot-schemas.ts";
import { withDatabase } from "../middleware/with-database.ts";
import { spotCard } from "../services/spots.ts";

const CARD_MAX_AGE_SECONDS = 300;

const getSpotCardRoute = publicRoute(
  {
    method: "get",
    path: "/v1/spots/{spotId}/card",
    operationId: "getSpotCard",
    tags: ["spots"],
    summary: "A published spot's card, for its shared link",
    description:
      "Name, kind, city and cover only: what the link's preview shows anyone. Not found for a spot that doesn't exist or was removed. Cacheable for a few minutes.",
    request: { params: z.object({ spotId: IdSchema }) },
    responses: answers(SpotCardSchema, "GetSpotCardResponse", "The spot's card"),
  },
  withDatabase,
);

export const spotCards = createRouter().openapi(getSpotCardRoute, async (c) => {
  const card = await spotCard(c.var.database.db, c.req.valid("param").spotId);
  c.header("Cache-Control", `public, max-age=${CARD_MAX_AGE_SECONDS}`);
  if (!card) return respondError(c, { code: "not_found", message: "No published spot with this id" });
  return c.json(success(card), 200);
});
