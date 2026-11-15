import type { z } from "@hono/zod-openapi";

type EdgeCache = Pick<Cache, "match" | "put">;

/** This data center's Cache API; there's none outside Workers (bun tests), so nothing is cached there. */
const edgeCache = (): EdgeCache | undefined => (typeof caches === "undefined" ? undefined : caches.default);

/**
 * `load()` at most once per `seconds` in each data center. Only for answers that are the same for every viewer:
 * the key is a URL alone, never the account.
 */
export async function sharedAnswer<T extends z.ZodType>(
  options: { key: string; seconds: number; schema: T; waitUntil: (promise: Promise<unknown>) => void; cache?: EdgeCache | undefined },
  load: () => Promise<z.output<T>>,
): Promise<z.output<T>> {
  const { key, seconds, schema, waitUntil, cache = edgeCache() } = options;
  const hit = await cache?.match(key);
  if (hit) {
    const cached = schema.safeParse(await hit.json().catch(() => undefined));
    if (cached.success) return cached.data;
  }
  const value = await load();
  // The Cache API keeps only public responses; the client still gets the route's own (private) header.
  if (cache) waitUntil(cache.put(key, Response.json(value, { headers: { "Cache-Control": `public, max-age=${seconds}` } })));
  return value;
}
