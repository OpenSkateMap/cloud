import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

// Hyperdrive's query caching is off: sync reads by version cursor and must never get a stale page.
const HYPERDRIVE_ID = "6a4f9eb2cf234bf9a17c6e0b4d9865b7";

export default defineConfig({
  accountId: "c9c7c46abcf1e3b57e5f03f53028ec46",
  worker: {
    name: "openskatemap-api",
    compatibilityDate: "2026-09-25",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint,
    domains: ["api.openskatemap.app"],
    workersDev: false,
    placement: { region: "aws:us-east-1" },
    observability: {
      enabled: true,
      redactQueryString: true,
      logs: { invocationLogs: true },
      traces: { enabled: true, headSamplingRate: 0.1 },
      issues: { enabled: true },
    },
    // Equal to `SCHEDULES` (src/schedules.ts): `cf dev` can't load app code here, so test/schedules.test.ts checks.
    triggers: ["0 17 * * SUN", "0 9 * * *", "*/10 * * * *", "30 3 * * *"].map((schedule) => triggers.scheduled({ schedule })),
    env: {
      HYPERDRIVE: bindings.hyperdrive({
        id: HYPERDRIVE_ID,
        dev: { connectionString: "postgres://openskatemap_app:openskatemap_app@localhost:54330/openskatemap" },
      }),
      // A flood guard per address, above what riders sharing one (carrier NAT, a park's Wi-Fi) would reach together.
      ADDRESS_LIMITER: bindings.rateLimit({ namespace: "1005", simple: { limit: 3000, period: 60 } }),
      API_LIMITER: bindings.rateLimit({ namespace: "1001", simple: { limit: 600, period: 60 } }),
      AUTH_LIMITER: bindings.rateLimit({ namespace: "1002", simple: { limit: 20, period: 60 } }),
      WRITE_LIMITER: bindings.rateLimit({ namespace: "1003", simple: { limit: 60, period: 60 } }),
      OUTREACH_LIMITER: bindings.rateLimit({ namespace: "1004", simple: { limit: 10, period: 60 } }),
      PHOTOS: bindings.r2({ name: "openskatemap-photos" }),
      API_ORIGIN: bindings.text("https://api.openskatemap.app"),
      APPLE_BUNDLE_IDS: bindings.text("com.ertembiyik.openskatemap,com.ertembiyik.openskatemap.dev"),
      BETTER_AUTH_SECRET: bindings.secret(),
      APPLE_TEAM_ID: bindings.text("MD55Y22MQS"),
      APPLE_SIGN_IN_KEY_ID: bindings.text("M7GZGGC9Z8"),
      APPLE_SIGN_IN_KEY: bindings.secret(),
      BUZZKIT_API_URL: bindings.text("https://push-api.openskatemap.app"),
      BUZZKIT_API_KEY: bindings.secret(),
      BUZZKIT_IDENTITY_SECRET: bindings.secret(),
      POSTHOG_PROJECT_TOKEN: bindings.text("phc_ksR9GhRebVK7mepaLCi6iw68bZpmaPD4zTiWkHe26Ppr"),
      POSTHOG_PROJECT_ID: bindings.text("666695"),
      POSTHOG_PERSONAL_API_KEY: bindings.secret(),
    },
  },
});
