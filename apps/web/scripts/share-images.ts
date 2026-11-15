// bun run scripts/share-images.ts [extra README header outputs…]
// Renders the home page's share image (site/share/home.jpg) and the READMEs' header (.github/assets/hero.jpg) from
// the built landing page itself, so both always look like the site. Run `bun run build` first.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const pages = path.join(root, ".pages");
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Shared by both: no site header, no motion, every element in its final place.
const still = `body > header, .nav-links, .tf-small { display: none !important; }
.hero-pin { animation: none !important; }
.reveal { opacity: 1 !important; translate: none !important; }
.lede .more { display: none; }
.lede { max-width: 640px; margin-inline: auto; }`;

const images = [
  {
    name: "share",
    size: { width: 1200, height: 630 },
    // 1.5×, not 2×: WhatsApp drops link previews over ~300 KB.
    scale: 1.5,
    quality: 80,
    outputs: [path.join(root, "site/share/home.jpg")],
    css: `.badges, .stage-note:nth-of-type(3) { display: none !important; }
.hero { padding-top: 64px !important; }
.hero h1 { font-size: 72px !important; }
.stage { margin-top: 28px !important; }
.stage-note:nth-of-type(1) { top: 196px !important; }
.stage-note:nth-of-type(2) { top: 276px !important; }`,
  },
  {
    name: "readme",
    size: { width: 1200, height: 600 },
    scale: 2,
    quality: 82,
    outputs: [path.join(root, "../../.github/assets/hero.jpg"), ...process.argv.slice(2)],
    css: `.hp-2, .hp-4, .stage-note:nth-of-type(3) { display: none !important; }
.hero { padding-top: 30px !important; }
.hero h1 { font-size: 76px !important; }
.badges { margin-top: 20px !important; }
.stage { margin-top: 30px !important; }
.stage-note:nth-of-type(1) { top: 40px !important; }
.stage-note:nth-of-type(2) { top: 120px !important; }`,
  },
] as const;

const home = await readFile(path.join(pages, "index.html"), "utf8").catch(() => {
  throw new Error("No built site: run `bun run build` first");
});
// The page's own policy and scripts stay out: the overrides are an inline style, and analytics shouldn't count a render.
const page = (css: string) =>
  home
    .replace(/<meta http-equiv="content-security-policy"[^>]*>/i, "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace("</head>", `<style>${still}\n${css}</style></head>`);

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const image = images.find((candidate) => pathname === `/__${candidate.name}`);
    if (image) return new Response(page(image.css), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    const file = Bun.file(path.join(pages, pathname.endsWith("/") ? `${pathname}index.html` : pathname));
    return (await file.exists()) ? new Response(file) : new Response("Not found", { status: 404 });
  },
});

const directory = await mkdtemp(path.join(tmpdir(), "share-images-"));
try {
  for (const image of images) {
    const png = path.join(directory, `${image.name}.png`);
    // Async: a sync spawn would block the server Chrome is loading the page from.
    const render = Bun.spawn([
      chrome,
      "--headless",
      "--hide-scrollbars",
      `--window-size=${image.size.width},${image.size.height}`,
      `--force-device-scale-factor=${image.scale}`,
      "--virtual-time-budget=5000",
      `--screenshot=${png}`,
      `${server.url}__${image.name}`,
    ], { stdout: "ignore", stderr: "pipe" });
    if ((await render.exited) !== 0) throw new Error(`Chrome failed: ${await new Response(render.stderr).text()}`);
    const jpeg = path.join(directory, `${image.name}.jpg`);
    const convert = Bun.spawnSync(["sips", "-s", "format", "jpeg", "-s", "formatOptions", String(image.quality), png, "--out", jpeg]);
    if (convert.exitCode !== 0) throw new Error(`sips failed: ${convert.stderr.toString()}`);
    const bytes = await readFile(jpeg);
    for (const output of image.outputs) await writeFile(output, bytes);
    console.log(`${image.name}: ${Math.round(bytes.length / 1024)} KB → ${image.outputs.join(", ")}`);
  }
} finally {
  await server.stop();
  await rm(directory, { recursive: true, force: true });
}
