import type { z } from "@hono/zod-openapi";

type EdgeCache = Pick<Cache, "match" | "put">;

interface SharingOptions {
  key: string;
  seconds: number;
  waitUntil: (promise: Promise<unknown>) => void;
  cache?: EdgeCache | undefined;
}

/** This data center's Cache API; there's none outside Workers (bun tests), so nothing is cached there. */
const edgeCache = (): EdgeCache | undefined => (typeof caches === "undefined" ? undefined : caches.default);

// The Cache API keeps only public responses; the client still gets the route's own header.
const publicCopy = (body: string, seconds: number) => new Response(body, { headers: { "Cache-Control": `public, max-age=${seconds}` } });

/**
 * `load()` at most once per `seconds` in each data center. Only for answers that are the same for every viewer:
 * the key is a URL alone, never the account.
 */
export async function sharedAnswer<T extends z.ZodType>(options: SharingOptions & { schema: T }, load: () => Promise<z.output<T>>): Promise<z.output<T>> {
  const { key, seconds, schema, waitUntil, cache = edgeCache() } = options;
  const hit = await cache?.match(key);
  if (hit) {
    const cached = schema.safeParse(await hit.json().catch(() => undefined));
    if (cached.success) return cached.data;
  }
  const value = await load();
  if (cache) waitUntil(cache.put(key, publicCopy(JSON.stringify(value), seconds)));
  return value;
}

/**
 * `sharedAnswer` for a large text served as stored, never parsed again: only for one that clients may keep as long
 * (`public, max-age=<seconds>`), so a copy older than a deploy is no staler than theirs.
 */
export async function sharedText(options: SharingOptions, load: () => Promise<string>): Promise<ReadableStream<Uint8Array> | string> {
  const { key, seconds, waitUntil, cache = edgeCache() } = options;
  const hit = await cache?.match(key);
  if (hit?.body) return hit.body;
  const text = await load();
  if (cache) waitUntil(cache.put(key, publicCopy(text, seconds)));
  return text;
}
