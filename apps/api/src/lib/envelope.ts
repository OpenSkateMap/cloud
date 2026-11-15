import { z } from "@hono/zod-openapi";

export function successEnvelope<T extends z.ZodType>(data: T, name: string) {
  return z.object({ ok: z.literal(true), data }).openapi(name);
}

export function success<T>(data: T) {
  return { ok: true as const, data };
}
