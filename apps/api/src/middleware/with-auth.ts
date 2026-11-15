import { createMiddleware } from "hono/factory";
import { createAuth } from "../auth/create-auth.ts";
import type { AppEnv } from "../env.ts";
import { parseAuthSettings } from "../lib/auth-settings.ts";
import { respondError } from "../lib/respond.ts";

export const withAuth = createMiddleware<AppEnv>(async (c, next) => {
  const settings = parseAuthSettings(c.env);
  if (!settings) {
    console.error("Auth settings are missing or invalid");
    return respondError(c, { code: "internal_error", message: "Something went wrong on our side" });
  }
  c.set("auth", createAuth(c.var.database.db, settings));
  await next();
});
