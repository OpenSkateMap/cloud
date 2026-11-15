import { z } from "@hono/zod-openapi";
import { success } from "../lib/envelope.ts";
import { MeSchema, toMe } from "../lib/me.ts";
import { createRouter } from "../lib/openapi-app.ts";
import { parseAppleTokenSettings } from "../lib/auth-settings.ts";
import { answers, authedRoute } from "../lib/routes.ts";
import { deleteAccount, eraseElsewhere } from "../services/account.ts";

const getMeRoute = authedRoute({
  method: "get",
  path: "/v1/me",
  operationId: "getMe",
  tags: ["account"],
  summary: "The signed-in account",
  responses: answers(MeSchema, "MeResponse", "The account"),
});

const deleteMeRoute = authedRoute({
  method: "delete",
  path: "/v1/me",
  operationId: "deleteMe",
  tags: ["account"],
  summary: "Delete the signed-in account now",
  description:
    "Deletes the account, its sessions, its Sign in with Apple link, its profile and its unused photos at once. Spots and submitted photos stay without attribution. Apple's tokens for the app are revoked first.",
  responses: answers(z.object({ deleted: z.literal(true) }), "DeleteMeResponse", "The account no longer exists"),
});

export const me = createRouter()
  .openapi(getMeRoute, async (c) => c.json(success(await toMe(c.var.user, c.env)), 200))
  .openapi(deleteMeRoute, async (c) => {
    await deleteAccount(c.var.database.db, c.env.PHOTOS, c.var.user.id, { apple: parseAppleTokenSettings(c.env) });
    for (const erasure of eraseElsewhere(c.env, c.var.user.id)) c.executionCtx.waitUntil(erasure);
    return c.json(success({ deleted: true as const }), 200);
  });
