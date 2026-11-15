import { createRoute, type RouteConfig, type z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env.ts";
import { rateLimitByAccount, rateLimitByIp } from "../middleware/rate-limit.ts";
import { requireBearer, requireUser } from "../middleware/require-user.ts";
import { withAuth } from "../middleware/with-auth.ts";
import { withDatabase } from "../middleware/with-database.ts";
import { successEnvelope } from "./envelope.ts";
import { errorResponses } from "./errors.ts";

// `P` keeps the path a literal; a `const` type parameter would make `responses` readonly (see `errorResponses`).
export function authedRoute<P extends string, R extends Omit<RouteConfig, "path" | "security" | "middleware"> & { path: P }>(
  config: R,
  ...extra: MiddlewareHandler<AppEnv>[]
) {
  // A plain array, not a tuple: zod-openapi folds a tuple's middleware envs into one, which collapses to `never` here.
  const middleware: MiddlewareHandler<AppEnv>[] = [
    requireBearer,
    withDatabase,
    withAuth,
    requireUser,
    rateLimitByAccount,
    ...extra,
  ];
  return createRoute({ ...config, security: [{ bearerAuth: [] }], middleware });
}

/** An operation anyone may call (listed in `PUBLIC_OPERATIONS`); it spends its address's API budget. */
export function publicRoute<P extends string, R extends Omit<RouteConfig, "path" | "security" | "middleware"> & { path: P }>(
  config: R,
  ...extra: MiddlewareHandler<AppEnv>[]
) {
  const middleware: MiddlewareHandler<AppEnv>[] = [rateLimitByIp("API_LIMITER"), ...extra];
  return createRoute({ ...config, middleware });
}

export const answers = <T extends z.ZodType>(schema: T, name: string, description: string) => ({
  200: { description, content: { "application/json": { schema: successEnvelope(schema, name) } } },
  ...errorResponses,
});

export const jsonBody = <T extends z.ZodType>(schema: T) => ({ required: true, content: { "application/json": { schema } } });
