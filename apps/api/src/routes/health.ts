import { z } from "@hono/zod-openapi";
import { sql } from "drizzle-orm";
import { success } from "../lib/envelope.ts";
import { logFailure } from "../lib/log.ts";
import { createRouter } from "../lib/openapi-app.ts";
import { respondError } from "../lib/respond.ts";
import { ResultAsync } from "../lib/result.ts";
import { answers, publicRoute } from "../lib/routes.ts";
import { withDatabase } from "../middleware/with-database.ts";

const HealthSchema = z.object({
  status: z.literal("ok"),
  database: z.literal("ok"),
});

const route = publicRoute(
  {
    method: "get",
    path: "/v1/health",
    operationId: "getHealth",
    tags: ["system"],
    summary: "Liveness of the API and its database",
    responses: answers(HealthSchema, "HealthResponse", "The API and the database both answer"),
  },
  withDatabase,
);

export const health = createRouter().openapi(route, async (c) => {
  const ping = await ResultAsync.fromPromise(c.var.database.db.execute(sql`select 1`), (error) => {
    logFailure("Health query failed", error);
    return { code: "unavailable", message: "The database is not answering" } as const;
  });
  if (ping.isErr()) return respondError(c, ping.error);
  return c.json(success({ status: "ok", database: "ok" } as const), 200);
});
