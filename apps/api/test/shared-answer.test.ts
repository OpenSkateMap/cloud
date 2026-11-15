import { describe, expect, test } from "bun:test";
import { z } from "@hono/zod-openapi";
import { sharedAnswer } from "../src/lib/shared-answer.ts";

const memoryCache = () => {
  const entries = new Map<string, Response>();
  return {
    entries,
    async match(key: RequestInfo | URL) {
      return entries.get(String(key))?.clone();
    },
    async put(key: RequestInfo | URL, response: Response) {
      entries.set(String(key), response);
    },
  };
};

describe("shared answers", () => {
  const schema = z.object({ items: z.array(z.int()) });
  const key = "https://api.test/v1/spot-scores";

  test("the first request loads and stores a public copy; the next ones answer from it", async () => {
    const cache = memoryCache();
    const pending: Promise<unknown>[] = [];
    let loads = 0;
    const answer = () =>
      sharedAnswer({ key, seconds: 60, schema, cache, waitUntil: (promise) => void pending.push(promise) }, async () => {
        loads += 1;
        return { items: [1, 2] };
      });

    expect(await answer()).toEqual({ items: [1, 2] });
    await Promise.all(pending);
    expect(cache.entries.get(key)?.headers.get("cache-control")).toBe("public, max-age=60");
    expect(await answer()).toEqual({ items: [1, 2] });
    expect(loads).toBe(1);
  });

  test("an entry that doesn't parse is loaded again", async () => {
    const cache = memoryCache();
    await cache.put(key, Response.json({ items: "nope" }));
    const fresh = await sharedAnswer({ key, seconds: 60, schema, cache, waitUntil: () => {} }, async () => ({ items: [3] }));
    expect(fresh).toEqual({ items: [3] });
  });
});
