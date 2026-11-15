import { z } from "zod";
import { prefersMarkdown } from "./accept.ts";
import { cardFonts } from "../site/fonts.ts";
import { escapeHTML, landingPolicy, layout, securityHeaders, type ShareImage } from "../site/layout.ts";
import { site } from "../site/site.ts";
import { kindTitles, spotCardDesign, spotKinds } from "../site/spot-card-layout.ts";
import { composeSpotCard } from "./spot-card.ts";

export type WorkerEnv = {
  ASSETS: { fetch(request: Request): Promise<Response> };
  API: { fetch(request: Request): Promise<Response> };
  IMAGES: Pick<ImagesBinding, "input" | "text">;
};

export type HandlerOptions = {
  cache?: Pick<Cache, "match" | "put"> | undefined;
  fetchPhoto?: (url: string) => Promise<Response>;
};

export const SpotCardSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  kind: z.enum(spotKinds),
  city: z.string().nullable(),
  cover: z.strictObject({ key: z.string(), width: z.int(), height: z.int(), thumbhash: z.string() }).nullable(),
  version: z.int(),
});
export type SpotCard = z.infer<typeof SpotCardSchema>;

const CardEnvelopeSchema = z.object({ ok: z.literal(true), data: SpotCardSchema });

const cacheSeconds = { page: 300, card: 86_400 } as const;

const spotPagePath = /^\/spots\/([\w-]{1,64})\/?$/;
const cardPath = /^\/cards\/spots\/([\w-]{1,64})\/(\d+)-(\d+)\.jpg$/;

export const cardImagePath = (card: Pick<SpotCard, "id" | "version">) => `/cards/spots/${card.id}/${card.version}-${spotCardDesign}.jpg`;

const placeLine = (card: SpotCard) => (card.city ? `${kindTitles[card.kind]} in ${card.city}` : `A ${kindTitles[card.kind].toLowerCase()} spot`);

async function fetchCard(env: WorkerEnv, id: string, visitor: string | null): Promise<SpotCard | undefined> {
  // The visitor's address goes along, so the API's per-address limit counts them, not this Worker.
  const request = new Request(`${site.api}/v1/spots/${encodeURIComponent(id)}/card`, { headers: visitor ? { "cf-connecting-ip": visitor } : {} });
  const response = await env.API.fetch(request);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`The API answered ${response.status}`);
  return CardEnvelopeSchema.parse(await response.json()).data;
}

function spotPage(card: SpotCard) {
  const share: ShareImage = { url: `${site.origin}${cardImagePath(card)}`, alt: `${card.title}: ${placeLine(card)}. Shared on ${site.name}.` };
  const meta = [kindTitles[card.kind], card.city].filter(Boolean).join(" · ");
  return layout({
    title: `${card.title} on ${site.name}`,
    description: `${placeLine(card)}, shared on ${site.name}.`,
    card: share,
    url: `${site.origin}/spots/${card.id}`,
    noindex: true,
    body: `<h1>${escapeHTML(card.title)}</h1>
<p class="meta">${escapeHTML(meta)}</p>
<img class="card" src="${cardImagePath(card)}" width="1200" height="630" alt="${escapeHTML(share.alt)}">
<p class="lede">Open this link on an iPhone with ${site.name} to see where it is</p>
<p class="soon">Coming to the App Store soon</p>`,
  });
}

const pageHeaders = (seconds: number) => ({
  ...securityHeaders(),
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": `public, max-age=${seconds}`,
  "X-Robots-Tag": "noindex",
});

async function genericSpotPage(env: WorkerEnv, url: URL, seconds: number) {
  const page = await env.ASSETS.fetch(new Request(new URL("/spot", url)));
  if (!page.ok) return new Response("This page is unavailable right now", { status: 503, headers: { "Cache-Control": "no-store" } });
  return new Response(page.body, { status: 200, headers: pageHeaders(seconds) });
}

async function respondToSpotPage(env: WorkerEnv, request: Request, url: URL, id: string) {
  let card: SpotCard | undefined;
  try {
    card = await fetchCard(env, id, request.headers.get("cf-connecting-ip"));
  } catch (error) {
    console.error("Spot card lookup failed", { name: error instanceof Error ? error.name : typeof error });
    return genericSpotPage(env, url, 0);
  }
  if (!card) return genericSpotPage(env, url, cacheSeconds.page);
  return new Response(spotPage(card), { headers: pageHeaders(cacheSeconds.page) });
}

async function respondToCard(env: WorkerEnv, request: Request, url: URL, id: string, version: number, design: number, fetchPhoto: (url: string) => Promise<Response>) {
  let card: SpotCard | undefined;
  try {
    card = await fetchCard(env, id, request.headers.get("cf-connecting-ip"));
  } catch (error) {
    console.error("Spot card lookup failed", { name: error instanceof Error ? error.name : typeof error });
    return new Response("The card is unavailable right now", { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  if (!card) return new Response("No such spot", { status: 404, headers: { "Cache-Control": `public, max-age=${cacheSeconds.page}` } });
  if (card.version !== version || design !== spotCardDesign) {
    return new Response(null, { status: 301, headers: { Location: cardImagePath(card), "Cache-Control": `public, max-age=${cacheSeconds.page}` } });
  }
  const part = async (path: string) => {
    const response = await env.ASSETS.fetch(new Request(new URL(`/${path}`, url)));
    if (!response.ok || !response.body) throw new Error(`Missing card part ${path}`);
    return response.body;
  };
  let cover: ReadableStream<Uint8Array> | undefined;
  if (card.cover) {
    const photo = await fetchPhoto(`${site.photos}/${card.cover.key}`).catch(() => undefined);
    cover = photo?.ok && photo.body ? photo.body : undefined;
  }
  // A card drawn without its cover is served but never kept, so the next request tries the photo again.
  const cacheControl = card.cover && !cover ? "no-store" : `public, max-age=${cacheSeconds.card}`;
  try {
    const image = await composeSpotCard(
      { name: card.title, kind: card.kind, city: card.city },
      { images: env.IMAGES, cover, part, fontURL: (font) => `${site.origin}/fonts/${cardFonts[font]}` },
    );
    return image.response({ headers: { "Cache-Control": cacheControl, "X-Robots-Tag": "noindex" } });
  } catch (error) {
    console.error("Spot card render failed", { name: error instanceof Error ? error.name : typeof error, code: error instanceof Error && "code" in error ? error.code : undefined });
    return new Response("The card couldn't be drawn", { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

// The Cache API, not Workers Cache, which would count every static asset request as a Worker request.
// The landing page's analytics reach PostHog through this first-party path, which ad blockers leave alone.
export const analyticsPath = "/ph/";

function proxyAnalytics(request: Request, url: URL) {
  const path = url.pathname.slice(analyticsPath.length - 1);
  const host = path.startsWith("/static/") ? "us-assets.i.posthog.com" : "us.i.posthog.com";
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  const ip = request.headers.get("cf-connecting-ip");
  if (ip) headers.set("X-Forwarded-For", ip);
  const body = request.method === "GET" || request.method === "HEAD" ? null : request.body;
  return fetch(new Request(`https://${host}${path}${url.search}`, { method: request.method, headers, body }));
}

// Pages with a Markdown twin, which the Worker sees first (`runWorkerFirst`) to answer `Accept: text/markdown`.
export const markdownTwins: Record<string, string> = { "/": "/index.md", "/privacy": "/privacy.md", "/terms": "/terms.md", "/support": "/support.md" };

async function serveStatic(env: WorkerEnv, request: Request, url: URL) {
  const twin = markdownTwins[url.pathname];
  if (twin === undefined || (request.method !== "GET" && request.method !== "HEAD")) return env.ASSETS.fetch(request);
  let response = prefersMarkdown(request.headers.get("Accept")) ? await env.ASSETS.fetch(new Request(new URL(twin, url), request)) : undefined;
  if (!response?.ok && response?.status !== 304) response = await env.ASSETS.fetch(request);
  const varied = new Response(response.body, response);
  varied.headers.append("Vary", "Accept");
  // On Cloudflare, _headers' detach of the site-wide policy doesn't reach a response the Worker serves, so the landing
  // page would carry both policies; its own <meta> policy needs only frame-ancestors from the header.
  if (url.pathname === "/") varied.headers.set("Content-Security-Policy", landingPolicy);
  return varied;
}

export function createHandler({ cache, fetchPhoto = (url) => fetch(url, { signal: AbortSignal.timeout(5000) }) }: HandlerOptions = {}) {
  return async (request: Request, env: WorkerEnv, ctx: Pick<ExecutionContext, "waitUntil">): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname.startsWith(analyticsPath)) return proxyAnalytics(request, url);
    const page = spotPagePath.exec(url.pathname);
    const image = cardPath.exec(url.pathname);
    if (!page && !image) return serveStatic(env, request, url);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    // The path alone keys the cache: a query string would otherwise force a fresh API call and Images render per request.
    const key = new Request(new URL(url.pathname, url.origin), { method: "GET" });
    let response = await cache?.match(key);
    if (!response) {
      response = page?.[1]
        ? await respondToSpotPage(env, request, url, page[1])
        : await respondToCard(env, request, url, image?.[1] ?? "", Number(image?.[2]), Number(image?.[3]), fetchPhoto);
      if (cache && /\bmax-age=[1-9]/.test(response.headers.get("Cache-Control") ?? "")) ctx.waitUntil(cache.put(key, response.clone()));
    }
    return request.method === "HEAD" ? new Response(null, response) : response;
  };
}

const handle = createHandler({ cache: typeof caches === "undefined" ? undefined : caches.default });

const apiHealth = "https://api.openskatemap.app/v1/health";

/**
 * The API's uptime check, from outside it: DNS, TLS, the Worker, Hyperdrive and the database. A failure throws, which
 * Workers Issues turns into an email (automations on openskatemap-web).
 */
export async function checkAPIHealth(fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch): Promise<void> {
  const response = await fetcher(apiHealth, { signal: AbortSignal.timeout(10_000) });
  const body: unknown = await response.json().catch(() => null);
  const healthy = response.ok && typeof body === "object" && body !== null && JSON.stringify(body).includes('"database":"ok"');
  if (!healthy) throw new Error(`API health check failed with ${response.status}`);
}

export default {
  fetch: (request, env, ctx) => handle(request, env, ctx),
  scheduled: () => checkAPIHealth(),
} satisfies ExportedHandler<Env>;
