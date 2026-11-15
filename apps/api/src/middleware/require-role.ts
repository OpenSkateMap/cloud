import { createMiddleware } from "hono/factory";
import type { Role } from "../auth/roles.ts";
import type { AppEnv } from "../env.ts";
import { respondError } from "../lib/respond.ts";

export const requireRole = (...allowed: readonly Exclude<Role, "admin">[]) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const { role } = c.var.user;
    if (role !== "admin" && !allowed.includes(role)) {
      return respondError(c, { code: "forbidden", message: "This account may not do this" });
    }
    await next();
  });
