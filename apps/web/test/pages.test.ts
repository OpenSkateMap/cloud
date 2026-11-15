import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import jpeg from "jpeg-js";
import { createHash } from "node:crypto";
import { pageStylesheet } from "../site/layout.ts";
import { buildPages, documentMarkdown } from "../site/pages.ts";

const landing = `<!doctype html><html lang="en"><head><title>OpenSkateMap</title></head><body><a href="/terms">Terms</a> <a href="/privacy">Privacy</a></body></html>`;

async function build(contact?: string) {
  const directory = await mkdtemp(path.join(tmpdir(), "openskatemap-pages-"));
  const files = await buildPages(directory, contact === undefined ? { home: landing } : { home: landing, contact });
  const read = (name: string) => readFile(path.join(directory, name), "utf8");
  return { directory, files, read };
}

describe("buildPages", () => {
  test("writes the landing page, the legal texts and support with their markdown twins, the 404 page, the cards and the headers", async () => {
    const { directory, files } = await build();
    const cards = files.filter((file) => file.startsWith("cards/") && !file.startsWith("cards/spot/"));
    expect(cards.map((file) => file.replace(/\.[0-9a-f]{10}\.jpg$/, "")).sort()).toEqual(
      ["cards/home", "cards/privacy", "cards/spot", "cards/support", "cards/terms"],
    );
    expect(files.filter((file) => file.startsWith("cards/spot/")).sort()).toEqual(
      ["cards/spot/diy.jpg", "cards/spot/frame.png", "cards/spot/grain.png", "cards/spot/park.jpg", "cards/spot/plaza.jpg", "cards/spot/street.jpg"],
    );
    expect(files.filter((file) => !file.startsWith("cards/")).sort()).toEqual(
      [
        "fonts/MonaSans-Medium.ttf",
        "fonts/MonaSansDisplayCondensed-Black.ttf",
        "fonts/OFL.txt",
        "404.html",
        "_headers",
        "_redirects",
        "apple-app-site-association.json",
        "collection.html",
        "index.html",
        "index.md",
        "llms.txt",
        "robots.txt",
        "privacy.html",
        "privacy.md",
        "spot.html",
        "support.html",
        "support.md",
        "terms.html",
        "terms.md",
      ].sort(),
    );
    await rm(directory, { recursive: true });
  });

  test("a markdown twin is the text its page renders, with the contact filled in", async () => {
    const { directory, read } = await build("hello@example.com");
    for (const slug of ["privacy", "terms", "support"]) {
      const markdown = await read(`${slug}.md`);
      expect(markdown).toBe(await documentMarkdown(slug, "hello@example.com"));
      expect(markdown).not.toContain("{{");
      expect(markdown).toContain("[hello@example.com](mailto:hello@example.com)");
      expect(await read(`${slug}.html`)).toContain('href="mailto:hello@example.com"');
    }
    await rm(directory, { recursive: true });
  });

  test("by default the texts name the real contact address", async () => {
    const { directory, read } = await build();
    expect(await read("privacy.md")).toContain("[hey@openskatemap.app](mailto:hey@openskatemap.app)");
    await rm(directory, { recursive: true });
  });

  test("every page links to both legal texts, which the app opens by these paths", async () => {
    const { directory, read } = await build();
    for (const page of ["index.html", "privacy.html", "terms.html", "404.html"]) {
      const html = await read(page);
      expect(html).toContain('href="/terms"');
      expect(html).toContain('href="/privacy"');
    }
    expect(await read("privacy.html")).toContain('<link rel="alternate" type="text/markdown" href="/privacy.md">');
    await rm(directory, { recursive: true });
  });

  test("spot links open in both iOS apps; the Worker owns /spots/*, and the generic page names no spot", async () => {
    const { directory, read } = await build();
    const association = JSON.parse(await read("apple-app-site-association.json"));
    expect(association.applinks.details[0].appIDs).toEqual([
      "MD55Y22MQS.com.ertembiyik.openskatemap",
      "MD55Y22MQS.com.ertembiyik.openskatemap.dev",
    ]);
    expect(association.applinks.details[0].components).toEqual([
      { "/": "/spots/*", comment: "A spot opens in the app" },
      { "/": "/collections/*", comment: "A collection opens in the app" },
    ]);
    const redirects = await read("_redirects");
    expect(redirects).toContain("/.well-known/apple-app-site-association /apple-app-site-association.json 200");
    expect(redirects).toBe("/.well-known/apple-app-site-association /apple-app-site-association.json 200\n/collections/* /collection 200\n");
    expect(await read("spot.html")).toContain("<h1>A spot on OpenSkateMap</h1>");
    await rm(directory, { recursive: true });
  });

  test("every page shares as a large card: an absolute, fingerprinted 1.91:1 JPEG small enough for WhatsApp, sized as its tags say", async () => {
    const { directory, read } = await build();
    const pages = { "index.html": "home", "privacy.html": "privacy", "terms.html": "terms", "support.html": "support", "spot.html": "spot", "404.html": "home" };
    for (const [page, card] of Object.entries(pages)) {
      const html = await read(page);
      const image = html.match(/<meta property="og:image" content="https:\/\/openskatemap\.app\/(cards\/[^"]+)">/)?.[1];
      expect(image).toMatch(new RegExp(`^cards/${card}\\.[0-9a-f]{10}\\.jpg$`));
      const bytes = await readFile(path.join(directory, image ?? ""));
      expect(bytes.length).toBeLessThan(300_000);
      const { width, height } = jpeg.decode(bytes, { useTArray: true });
      expect(width / height).toBeCloseTo(1200 / 630, 2);
      expect(html).toContain(`<meta property="og:image:width" content="${width}">`);
      expect(html).toContain(`<meta property="og:image:height" content="${height}">`);
      expect(html).toContain('<meta property="og:image:alt" content="OpenSkateMap: ');
      expect(html).toContain('<meta property="og:site_name" content="OpenSkateMap">');
      expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    }
    expect(await read("index.html")).toContain('<meta property="og:url" content="https://openskatemap.app/">');
    expect(await read("privacy.html")).toContain('<meta property="og:url" content="https://openskatemap.app/privacy">');
    expect(await read("_headers")).toContain("/cards/*\n  Cache-Control: public, max-age=31536000, immutable");
    await rm(directory, { recursive: true });
  });

  test("a spot link's card and tags name no spot, and every spot link keeps its own address", async () => {
    const { directory, read } = await build();
    const html = await read("spot.html");
    expect(html).not.toContain("og:url");
    expect(html).toContain('<meta property="og:title" content="A spot on OpenSkateMap">');
    expect(html).toContain('content="OpenSkateMap: A skater sent you a spot. Open the link on an iPhone with OpenSkateMap."');
    await rm(directory, { recursive: true });
  });

  test("markdown is served as markdown, no page allows inline code, and the landing page brings its own policy", async () => {
    const { directory, read } = await build();
    const headers = await read("_headers");
    expect(headers).toContain("/*.md\n  Content-Type: text/markdown; charset=utf-8");
    expect(headers).toContain("default-src 'none'");
    expect(headers).toContain("/\n  ! Content-Security-Policy\n  Content-Security-Policy: frame-ancestors 'none'\n");
    expect(headers).not.toContain("unsafe-inline");
    expect(headers).toContain("/collections/*\n  X-Robots-Tag: noindex");
    expect(await read("spot.html")).toContain('<meta name="robots" content="noindex">');
    await rm(directory, { recursive: true });
  });

  test("the inlined page stylesheet matches the hash its policy allows", () => {
    expect(pageStylesheet.hash).toBe(`sha256-${createHash("sha256").update(pageStylesheet.text).digest("base64")}`);
  });
});
