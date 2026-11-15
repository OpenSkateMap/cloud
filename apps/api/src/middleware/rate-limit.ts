import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env.ts";
import { respondError } from "../lib/respond.ts";

type LimiterName = { [K in keyof Env]-?: Env[K] extends RateLimit ? K : never }[keyof Env];

// Must match each binding's `period` in cloudflare.config.ts; a full window is the wait we can promise.
const WINDOW_SECONDS = {
  ADDRESS_LIMITER: 60,
  API_LIMITER: 60,
  AUTH_LIMITER: 60,
  WRITE_LIMITER: 60,
  OUTREACH_LIMITER: 60,
} as const satisfies Record<LimiterName, 10 | 60>;

// An IPv6 host usually holds a whole /64; counting addresses apart would let one machine rotate through buckets.
export function clientKey(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped?.[1]) return mapped[1];
  if (!address.includes(":")) return address;
  const [head = "", tail] = address.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return `${groups
    .slice(0, 4)
    .map((group) => group.padStart(4, "0"))
    .join(":")}::/64`;
}

function limit(limiter: LimiterName, keyOf: (c: Context<AppEnv>) => string, message: string) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const { success } = await c.env[limiter].limit({ key: keyOf(c) });
    if (!success) {
      return respondError(c, { code: "rate_limited", message, details: { retry_after_seconds: WINDOW_SECONDS[limiter] } });
    }
    await next();
  });
}

export const rateLimitByIp = (limiter: LimiterName) =>
  limit(limiter, (c) => clientKey(c.req.header("cf-connecting-ip") ?? "unknown"), "Too many requests from this address");

/** Signed-in requests spend their account's budget, so riders sharing an address don't share one. */
export const rateLimitByAccount = limit("API_LIMITER", (c) => `account:${c.var.user.id}`, "Too many requests in a short time");

// One kind of write never spends another's budget: tapping through votes can't stall the outbox.
const WRITE_LIMITERS = {
  contributions: "WRITE_LIMITER",
  votes: "WRITE_LIMITER",
  collections: "WRITE_LIMITER",
  review: "WRITE_LIMITER",
  profile: "WRITE_LIMITER",
  outreach: "OUTREACH_LIMITER",
} as const satisfies Record<string, LimiterName>;

export type WriteFamily = keyof typeof WRITE_LIMITERS;

export const limitWrites = (family: WriteFamily) =>
  limit(WRITE_LIMITERS[family], (c) => `${family}:${c.var.user.id}`, "Too many changes in a short time");
