import { createMiddleware } from "hono/factory";
import { RoleSchema } from "../auth/roles.ts";
import type { AppEnv } from "../env.ts";
import { respondError } from "../lib/respond.ts";

const signInAgain = { code: "auth_required", message: "Sign in to continue" } as const;

export const requireBearer = createMiddleware<AppEnv>(async (c, next) => {
  if (!/^Bearer \S+$/.test(c.req.header("authorization") ?? "")) return respondError(c, signInAgain);
  await next();
});

// The admin plugin's ban columns are on the user at runtime but missing from its inferred type.
function isBanned(user: { readonly banned?: unknown; readonly banExpires?: unknown }, now: Date) {
  const expires =
    user.banExpires instanceof Date || typeof user.banExpires === "string" ? new Date(user.banExpires) : undefined;
  return user.banned === true && (!expires || expires > now);
}

export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  const session = await c.var.auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return respondError(c, signInAgain);
  // A ban revokes sessions, but one created in a race with the ban must not keep working.
  if (isBanned(session.user, new Date())) {
    return respondError(c, { code: "forbidden", message: "This account is disabled" });
  }
  const role = RoleSchema.safeParse(session.user.role ?? "user");
  if (!role.success) return respondError(c, { code: "forbidden", message: "This account has no usable role" });
  c.set("user", {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
    role: role.data,
    createdAt: session.user.createdAt,
  });
  await next();
});
