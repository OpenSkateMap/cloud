import { openDatabase } from "@openskatemap/db";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env.ts";
import { logFailure } from "../lib/log.ts";
import { respondError } from "../lib/respond.ts";

export const withDatabase = createMiddleware<AppEnv>(async (c, next) => {
  let database;
  try {
    database = await openDatabase(c.env.HYPERDRIVE.connectionString);
  } catch (error) {
    logFailure("Database connection failed", error);
    return respondError(c, { code: "unavailable", message: "The database is not answering" });
  }
  try {
    c.set("database", database);
    await next();
  } finally {
    c.executionCtx.waitUntil(database.close());
  }
});
