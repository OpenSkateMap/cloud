import { z } from "@hono/zod-openapi";
import { schema } from "@openskatemap/db";
import { APIError } from "better-auth/api";
import { eq } from "drizzle-orm";
import { verifyAppleNotification } from "../auth/apple-notifications.ts";
import { RoleSchema } from "../auth/roles.ts";
import { success } from "../lib/envelope.ts";
import { parseAppleTokenSettings, parseAuthSettings } from "../lib/auth-settings.ts";
import { logFailure } from "../lib/log.ts";
import { MeSchema, toMe } from "../lib/me.ts";
import { createRouter } from "../lib/openapi-app.ts";
import { respondError } from "../lib/respond.ts";
import { answers, authedRoute, jsonBody, publicRoute } from "../lib/routes.ts";
import { rateLimitByIp } from "../middleware/rate-limit.ts";
import { withAuth } from "../middleware/with-auth.ts";
import { withDatabase } from "../middleware/with-database.ts";
import { applyAppleAccountEvent, cancelAppleAccountDeletion } from "../services/apple-account-events.ts";
import { rememberAppleToken } from "../services/apple-tokens.ts";

const SignInWithAppleSchema = z
  .object({
    idToken: z.string().min(1).openapi({ description: "Apple's identity token (JWT) from ASAuthorizationAppleIDCredential" }),
    nonce: z.string().min(16).max(256).openapi({ description: "The raw nonce; the app sent its SHA-256 hex digest to Apple" }),
    givenName: z.string().trim().min(1).max(100).optional().openapi({ description: "Only on the first sign-in" }),
    familyName: z.string().trim().min(1).max(100).optional().openapi({ description: "Only on the first sign-in" }),
    authorizationCode: z
      .string()
      .min(1)
      .max(2048)
      .optional()
      .openapi({ description: "ASAuthorizationAppleIDCredential.authorizationCode, so deleting the account can revoke Apple's tokens" }),
  })
  .openapi("SignInWithAppleRequest");

const SessionSchema = z
  .object({
    token: z.string().openapi({ description: "Send as `Authorization: Bearer <token>`" }),
    user: MeSchema,
  })
  .openapi("Session");

const signInRoute = publicRoute(
  {
    method: "post",
    path: "/v1/auth/apple",
    operationId: "signInWithApple",
    tags: ["auth"],
    summary: "Sign in (or sign up) with a Sign in with Apple identity token",
    request: { body: jsonBody(SignInWithAppleSchema) },
    responses: answers(SessionSchema, "SessionResponse", "Signed in; the token opens a session"),
  },
  rateLimitByIp("AUTH_LIMITER"),
  withDatabase,
  withAuth,
);

const appleNotificationRoute = publicRoute(
  {
    method: "post",
    path: "/v1/auth/apple/notifications",
    operationId: "receiveAppleNotification",
    tags: ["auth"],
    summary: "Apple's server-to-server notices about Sign in with Apple accounts (registered on the App ID)",
    request: {
      body: jsonBody(
        z
          .object({ payload: z.string().min(1).max(8192).openapi({ description: "A JWT signed by Apple" }) })
          .openapi("AppleNotification"),
      ),
    },
    responses: answers(z.object({ received: z.literal(true) }), "AppleNotificationResponse", "Read; Apple stops sending it"),
  },
  withDatabase,
);

const signOutRoute = authedRoute({
  method: "post",
  path: "/v1/auth/logout",
  operationId: "signOut",
  tags: ["auth"],
  summary: "End this session",
  responses: answers(z.object({ signedOut: z.literal(true) }), "SignOutResponse", "The session no longer works"),
});

export const auth = createRouter()
  .openapi(signInRoute, async (c) => {
    const { idToken, nonce, givenName, familyName, authorizationCode } = c.req.valid("json");
    let result;
    try {
      result = await c.var.auth.api.signInSocial({
        body: {
          provider: "apple",
          idToken: {
            token: idToken,
            nonce,
            ...((givenName || familyName) && { user: { name: { firstName: givenName ?? "", lastName: familyName ?? "" } } }),
          },
        },
        headers: c.req.raw.headers,
      });
    } catch (error) {
      if (error instanceof APIError && error.statusCode < 500) {
        return respondError(c, { code: "auth_required", message: "Sign in with Apple could not be verified" });
      }
      logFailure("Sign in with Apple failed", error);
      return respondError(c, { code: "unavailable", message: "Sign in is not available right now" });
    }
    if (!("token" in result) || !result.token) {
      return respondError(c, { code: "auth_required", message: "Sign in with Apple could not be verified" });
    }
    const [row] = await c.var.database.db.select().from(schema.user).where(eq(schema.user.id, result.user.id));
    if (!row) return respondError(c, { code: "internal_error", message: "Something went wrong on our side" });
    const role = RoleSchema.parse(row.role ?? "user");
    await cancelAppleAccountDeletion(c.var.database.db, row.id);
    const apple = parseAppleTokenSettings(c.env);
    if (apple && authorizationCode) {
      const kept = await rememberAppleToken(c.var.database.db, apple, { userId: row.id, idToken, authorizationCode });
      if (kept.isErr()) console.warn("Apple refresh token not kept", { reason: kept.error });
    }
    return c.json(success({ token: result.token, user: await toMe({ ...row, role }, c.env) }), 200);
  })
  .openapi(appleNotificationRoute, async (c) => {
    const settings = parseAuthSettings(c.env);
    if (!settings) {
      console.error("Auth settings are missing or invalid");
      return respondError(c, { code: "internal_error", message: "Something went wrong on our side" });
    }
    const event = await verifyAppleNotification(c.req.valid("json").payload, settings.appleBundleIds);
    if (event.isErr()) {
      console.warn("Apple notification refused", { reason: event.error });
      return respondError(c, { code: "forbidden", message: "This isn't a notice from Apple" });
    }
    const outcome = await applyAppleAccountEvent(c.var.database.db, event.value);
    console.log("Apple account event", { type: event.value.type, outcome });
    return c.json(success({ received: true as const }), 200);
  })
  .openapi(signOutRoute, async (c) => {
    await c.var.auth.api.signOut({ headers: c.req.raw.headers });
    return c.json(success({ signedOut: true as const }), 200);
  });
