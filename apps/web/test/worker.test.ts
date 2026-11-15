import { describe, expect, test } from "bun:test";
import config from "../wrangler.jsonc";
import { layOutSpotCard, spotCardTile } from "../site/spot-card-layout.ts";
import { analyticsPath, cardImagePath, checkAPIHealth, createHandler, markdownTwins, type SpotCard, type WorkerEnv } from "../src/index.ts";

const card: SpotCard = {
  id: "0199d3c4-7a51-7b20-9f6e-2b8f0c1d4e5a",
  title: "Southbank Undercroft",
  kind: "plaza",
  city: "London",
  cover: { key: "photos/cover.jpg", width: 1600, height: 1200, thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI" },
  version: 42,
};

type Draw = { kind: "image" | "text"; label: string; transforms: ImageTransform[]; options: ImageDrawOptions | undefined };

type FakeTransformer = ImageTransformer & { label: string; transforms: ImageTransform[] };

function fakes(cards: Record<string, SpotCard | "error">) {
  const apiCalls: Request[] = [];
  const draws: Draw[] = [];
  const texts: { content: string; options: TextOptions }[] = [];
  const outputs: string[] = [];
  // Each stream the Worker hands to Images, named by where it came from: an asset's path, or "cover".
  const streams = new WeakMap<ReadableStream, string>();
  const named = (response: Response, label: string) => (response.body && streams.set(response.body, label), response);
  const transformer = (label: string, transforms: ImageTransform[] = []): FakeTransformer => ({
    label,
    transforms,
    transform: (transform) => transformer(label, [...transforms, transform]),
    draw(image, options) {
      const drawn = "label" in image ? (image as FakeTransformer) : transformer("stream");
      draws.push({ kind: drawn.label.startsWith("text:") ? "text" : "image", label: drawn.label, transforms: drawn.transforms, options });
      return transformer(label, transforms);
    },
    output: async () => {
      outputs.push(label);
      return {
        response: (options) => new Response("jpeg", { headers: { "Content-Type": "image/jpeg", ...Object.fromEntries(new Headers(options?.headers)) } }),
        contentType: () => "image/jpeg",
        image: () => new Response("jpeg").body!,
      };
    },
  });
  const env: WorkerEnv = {
    ASSETS: { fetch: async (request) => named(new Response(`asset ${new URL(request.url).pathname}`), new URL(request.url).pathname) },
    API: {
      async fetch(request) {
        apiCalls.push(request);
        const id = new URL(request.url).pathname.split("/")[3] ?? "";
        const found = cards[id];
        if (found === "error") return new Response("boom", { status: 500 });
        if (!found) return Response.json({ ok: false, error: { code: "not_found" } }, { status: 404 });
        return Response.json({ ok: true, data: found });
      },
    },
    IMAGES: {
      input: (stream) => transformer(stream instanceof ReadableStream ? (streams.get(stream) ?? "stream") : "stream"),
      text: (content, options) => {
        texts.push({ content, options });
        return transformer(`text:${content}`);
      },
    },
  };
  return { env, apiCalls, draws, texts, outputs, named };
}

const memoryCache = () => {
  const entries = new Map<string, Response>();
  return {
    entries,
    match: async (request: RequestInfo | URL) => entries.get(new Request(request).url)?.clone(),
    put: async (request: RequestInfo | URL, response: Response) => void entries.set(new Request(request).url, response),
  };
};

const context = () => {
  const pending: Promise<unknown>[] = [];
  return { waitUntil: (promise: Promise<unknown>) => void pending.push(promise), settle: () => Promise.all(pending) };
};

const visitor = { headers: { "cf-connecting-ip": "203.0.113.7" } };

describe("the site's Worker", () => {
  test("runs only for spot pages, spot cards, the analytics proxy and pages with a Markdown twin; everything else stays static", () => {
    expect(config.assets.run_worker_first).toEqual(["/spots/*", "/cards/spots/*", `${analyticsPath}*`, ...Object.keys(markdownTwins)]);
  });

  test("analytics go to PostHog through /ph without the visitor's cookies, with their IP for GeoIP", async () => {
    const { env } = fakes({});
    const sent: Request[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Request) => (sent.push(input), new Response("ok"))) as typeof fetch;
    try {
      const handle = createHandler();
      await handle(new Request("https://openskatemap.app/ph/e/?compression=gzip", { method: "POST", body: "{}", headers: { cookie: "a=1", "cf-connecting-ip": "203.0.113.7" } }), env, context());
      await handle(new Request("https://openskatemap.app/ph/static/array.js"), env, context());
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(sent.map((request) => request.url)).toEqual(["https://us.i.posthog.com/e/?compression=gzip", "https://us-assets.i.posthog.com/static/array.js"]);
    expect(sent[0]?.headers.get("cookie")).toBeNull();
    expect(sent[0]?.headers.get("x-forwarded-for")).toBe("203.0.113.7");
    expect(await sent[0]?.text()).toBe("{}");
  });

  test("a page with a Markdown twin answers Accept: text/markdown with it, HTML otherwise, varying on Accept", async () => {
    const { env } = fakes({});
    const handle = createHandler();
    const markdown = await handle(new Request("https://openskatemap.app/terms", { headers: { Accept: "text/markdown, text/html;q=0.9" } }), env, context());
    expect(await markdown.text()).toBe("asset /terms.md");
    expect(markdown.headers.get("vary")).toBe("Accept");
    for (const accept of ["text/html", "*/*", "text/markdown;q=0.5, text/html"]) {
      const html = await handle(new Request("https://openskatemap.app/", { headers: { Accept: accept } }), env, context());
      expect(await html.text()).toBe("asset /");
      expect(html.headers.get("vary")).toBe("Accept");
    }
    expect(await (await handle(new Request("https://openskatemap.app/favicon.ico", { headers: { Accept: "text/markdown" } }), env, context())).text()).toBe("asset /favicon.ico");
    const strict = { ...env, ASSETS: { fetch: async () => new Response("<html>", { headers: { "Content-Security-Policy": "default-src 'none'" } }) } };
    const home = await handle(new Request("https://openskatemap.app/"), strict, context());
    expect(home.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
  });

  test("a known spot's page names it, its kind and city, and shares its own card, nothing else", async () => {
    const { env, apiCalls } = fakes({ [card.id]: card });
    const response = await createHandler()(new Request(`https://openskatemap.app/spots/${card.id}`, visitor), env, context());
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('<meta property="og:title" content="Southbank Undercroft on OpenSkateMap">');
    expect(html).toContain('<meta property="og:description" content="Plaza in London, shared on OpenSkateMap.">');
    expect(html).toContain(`<meta property="og:image" content="https://openskatemap.app/cards/spots/${card.id}/42-2.jpg">`);
    expect(html).toContain(`<meta property="og:url" content="https://openskatemap.app/spots/${card.id}">`);
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain("<h1>Southbank Undercroft</h1>");
    expect(html).not.toContain("photos/cover.jpg");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(response.headers.get("content-security-policy")).toContain("img-src 'self' data:");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(apiCalls[0]?.headers.get("cf-connecting-ip")).toBe("203.0.113.7");
  });

  test("a name is escaped wherever it lands", async () => {
    const { env } = fakes({ x1: { ...card, id: "x1", title: '<script>alert("hi")</script> & Co' } });
    const html = await (await createHandler()(new Request("https://openskatemap.app/spots/x1"), env, context())).text();
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(&quot;hi&quot;)&lt;/script&gt; &amp; Co");
  });

  test("a query string shares the path's cache entry", async () => {
    const { env, apiCalls } = fakes({ [card.id]: card });
    const handle = createHandler({ cache: memoryCache() });
    for (const query of ["", "?a=1", "?a=2"]) {
      const ctx = context();
      await handle(new Request(`https://openskatemap.app/spots/${card.id}${query}`), env, ctx);
      await ctx.settle();
    }
    expect(apiCalls).toHaveLength(1);
  });

  test("an unknown or removed spot gets the generic page; an API failure too, but it isn't kept", async () => {
    const { env } = fakes({ broken: "error" });
    const cache = memoryCache();
    const handle = createHandler({ cache });
    const unknown = await handle(new Request("https://openskatemap.app/spots/gone"), env, context());
    expect(await unknown.text()).toBe("asset /spot");
    expect(unknown.headers.get("cache-control")).toBe("public, max-age=300");
    const ctx = context();
    const failed = await handle(new Request("https://openskatemap.app/spots/broken"), env, ctx);
    await ctx.settle();
    expect(await failed.text()).toBe("asset /spot");
    expect(failed.headers.get("cache-control")).toBe("public, max-age=0");
    expect(cache.entries.has("https://openskatemap.app/spots/broken")).toBe(false);
  });

  test("a card whose cover can't be fetched is served but not kept", async () => {
    const { env } = fakes({ [card.id]: card });
    const cache = memoryCache();
    const handle = createHandler({ cache, fetchPhoto: async () => { throw new DOMException("timed out", "TimeoutError"); } });
    const ctx = context();
    const response = await handle(new Request(`https://openskatemap.app${cardImagePath(card)}`), env, ctx);
    await ctx.settle();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(cache.entries.size).toBe(0);
  });

  test("a card is the base, the cover cropped to the tile, the frame that rounds it, the pill, then the text, and cached", async () => {
    const { env, draws, texts, outputs, apiCalls, named } = fakes({ [card.id]: card });
    const photos: string[] = [];
    const cache = memoryCache();
    const handle = createHandler({ cache, fetchPhoto: async (url) => (photos.push(url), named(new Response("cover"), "cover")) });
    const ctx = context();
    const response = await handle(new Request(`https://openskatemap.app${cardImagePath(card)}`), env, ctx);
    await ctx.settle();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(photos).toEqual(["https://images.openskatemap.app/photos/cover.jpg"]);
    expect(outputs).toEqual(["/cards/spot/base.jpg"]);
    const { cover } = spotCardTile;
    const layout = layOutSpotCard({ name: card.title, kind: card.kind, city: card.city });
    expect(draws.filter((draw) => draw.kind === "image").map(({ label, transforms, options }) => ({ label, transforms, options }))).toEqual([
      { label: "cover", transforms: [{ width: cover.size, height: cover.size, fit: "cover", gravity: "auto" }], options: { left: cover.left, top: cover.top } },
      { label: "/cards/spot/frame.png", transforms: [], options: { left: spotCardTile.left, top: spotCardTile.top } },
      { label: "/cards/spot/pill.png", transforms: [], options: layout.pill },
    ]);
    const kinds = draws.map((draw) => draw.kind);
    expect(kinds.indexOf("text")).toBeGreaterThan(kinds.lastIndexOf("image"));
    expect(texts.map((text) => [text.content, text.options.color])).toEqual([
      ["Southbank", "#000000"],
      ["Undercroft", "#000000"],
      ["Plaza · London", "#555555"],
    ]);
    expect(new Set(texts.map((text) => text.options.font.url))).toEqual(
      new Set(["https://openskatemap.app/fonts/InterDisplay-Bold.ttf", "https://openskatemap.app/fonts/InterDisplay-Regular.ttf"]),
    );
    await handle(new Request(`https://openskatemap.app${cardImagePath(card)}`), env, context());
    expect(apiCalls).toHaveLength(1);
  });

  test("a card draws with the fonts its own deployment serves", async () => {
    const { env, texts } = fakes({ [card.id]: card });
    await createHandler({ fetchPhoto: async () => new Response("cover") })(new Request(`https://preview.example.workers.dev${cardImagePath(card)}`), env, context());
    expect(texts.every((text) => text.options.font.url.startsWith("https://preview.example.workers.dev/fonts/"))).toBe(true);
  });

  test("an old card URL points at the spot's current card, an old design's too; a removed spot's card is gone", async () => {
    const { env } = fakes({ [card.id]: card });
    for (const old of [`/cards/spots/${card.id}/41-2.jpg`, `/cards/spots/${card.id}/42-1.jpg`]) {
      const response = await createHandler()(new Request(`https://openskatemap.app${old}`), env, context());
      expect(response.status).toBe(301);
      expect(response.headers.get("location")).toBe(cardImagePath(card));
    }
    const gone = await createHandler()(new Request("https://openskatemap.app/cards/spots/gone/3-2.jpg"), env, context());
    expect(gone.status).toBe(404);
  });

  test("a spot without a cover gets its kind's empty tile in the cover's place, rounded by the same frame", async () => {
    const bare = { ...card, id: "bare", cover: null, city: null };
    const { env, draws } = fakes({ bare });
    const photos: string[] = [];
    const response = await createHandler({ fetchPhoto: async (url) => (photos.push(url), new Response("cover")) })(
      new Request(`https://openskatemap.app${cardImagePath(bare)}`),
      env,
      context(),
    );
    expect(response.status).toBe(200);
    expect(photos).toEqual([]);
    const { cover } = spotCardTile;
    expect(draws.filter((draw) => draw.kind === "image").map(({ label, transforms, options }) => ({ label, transforms, options }))).toEqual([
      { label: "/cards/spot/empty-plaza.png", transforms: [], options: { left: cover.left, top: cover.top } },
      { label: "/cards/spot/frame.png", transforms: [], options: { left: spotCardTile.left, top: spotCardTile.top } },
      { label: "/cards/spot/pill.png", transforms: [], options: layOutSpotCard({ name: bare.title, kind: bare.kind, city: bare.city }).pill },
    ]);
    expect(draws.filter((draw) => draw.kind === "text").at(-1)?.label).toBe("text:Plaza");
  });

  test("only GET and HEAD; a HEAD has no body", async () => {
    const { env } = fakes({ [card.id]: card });
    const post = await createHandler()(new Request(`https://openskatemap.app/spots/${card.id}`, { method: "POST" }), env, context());
    expect(post.status).toBe(405);
    const head = await createHandler()(new Request(`https://openskatemap.app/spots/${card.id}`, { method: "HEAD" }), env, context());
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });
});

describe("API uptime check", () => {
  const answer = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });

  test("passes when the API and its database answer", async () => {
    await checkAPIHealth(answer(200, { ok: true, data: { status: "ok", database: "ok" } }));
  });

  test("throws when the API is down or its database isn't", async () => {
    await expect(checkAPIHealth(answer(503, { ok: false }))).rejects.toThrow("API health check failed with 503");
    await expect(checkAPIHealth(answer(200, { ok: true, data: { status: "ok", database: "down" } }))).rejects.toThrow();
  });
});
