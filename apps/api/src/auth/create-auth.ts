import type { Database } from "@openskatemap/db";
import { schema } from "@openskatemap/db";
import { betterAuth } from "better-auth/minimal";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, bearer } from "better-auth/plugins";
import { errorSummary } from "../lib/log.ts";
import { accessControl } from "./roles.ts";

export interface AuthSettings {
  readonly apiOrigin: string;
  readonly secret: string;
  readonly appleBundleIds: readonly [string, ...string[]];
}

// Better Auth logs raw errors, and a failed query's message carries its bound parameters (session tokens among them).
export function redactedLog(level: "debug" | "info" | "warn" | "error", message: unknown, ...args: unknown[]) {
  const label =
    typeof message === "string" &&
    message.length <= 200 &&
    !/failed query|params:|select |insert |update |delete /i.test(message)
      ? message
      : message instanceof Error
        ? errorSummary(message).name
        : "[details withheld]";
  const safe = [message, ...args].flatMap((arg) => (arg instanceof Error ? [errorSummary(arg)] : []));
  const line = `[Better Auth] ${label}`;
  if (level === "error") console.error(line, ...safe);
  else if (level === "warn") console.warn(line, ...safe);
  else console.log(line, ...safe);
}

export function createAuth(db: Database, settings: AuthSettings) {
  const [releaseBundleId] = settings.appleBundleIds;
  return betterAuth({
    appName: "OpenSkateMap",
    baseURL: settings.apiOrigin,
    basePath: "/api/auth",
    secret: settings.secret,
    database: drizzleAdapter(db, { provider: "pg", schema }),
    logger: { log: redactedLog },
    socialProviders: {
      apple: {
        clientId: releaseBundleId,
        clientSecret: "",
        appBundleIdentifier: releaseBundleId,
        audience: [...settings.appleBundleIds],
      },
    },
    account: {
      encryptOAuthTokens: true,
      // An email match must never attach a sign-in to another account.
      accountLinking: { enabled: false },
    },
    // In a Worker its counters would live in Postgres; the rate-limit bindings run first instead.
    rateLimit: { enabled: false },
    advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
    session: {
      // A ban or a revoked session must take effect on the very next request.
      cookieCache: { enabled: false },
      expiresIn: 60 * 60 * 24 * 60,
      updateAge: 60 * 60 * 24,
    },
    plugins: [
      bearer(),
      admin({ ...accessControl, defaultRole: "user", adminRoles: ["admin"] }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
