// bun run scripts/share-images.ts [extra README header outputs…]
// Renders every share image in headless Chrome: the home page's (site/share/home.jpg) and the READMEs' header
// (.github/assets/hero.jpg) from the built landing page itself, the other pages' cards (site/share/<name>.jpg), and the
// parts the Worker composes each spot's card from (site/share/spot-card/*). Run `bun run build` first, then commit them.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type ShareCard, sentence, shareCards, shareDirectory } from "../site/cards.ts";
import { escapeHTML } from "../site/layout.ts";
import { site } from "../site/site.ts";
import { spotCardBrand, spotCardColumn, spotCardParts, spotCardSize as size, spotCardTile } from "../site/spot-card-layout.ts";

const root = path.join(import.meta.dirname, "..");
const landingBuild = path.join(root, ".site");
const landingAssets = path.join(root, "landing/assets");
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Shared by both: no site header, no motion, every element in its final place.
const still = `body > header, .nav-links, .tf-small { display: none !important; }
.hero-pin { animation: none !important; }
.reveal { opacity: 1 !important; translate: none !important; }
.lede .more { display: none; }
.lede { max-width: 640px; margin-inline: auto; }`;

// One composition for both: the hero's headline and lede, its four spots, the phone and two notes placed clear of them.
const composition = `.badges, .stage-note:nth-of-type(3) { display: none !important; }
.hero { padding-top: 64px !important; }
.hero h1 { font-size: 72px !important; }
.stage { margin-top: 28px !important; }
.stage-note:nth-of-type(1) { top: 196px !important; }
.stage-note:nth-of-type(2) { top: 276px !important; }`;

const home = await readFile(path.join(landingBuild, "index.html"), "utf8").catch(() => {
  throw new Error("No built site: run `bun run build` first");
});
// The page's own policy and scripts stay out: the overrides are an inline style, and analytics shouldn't count a render.
const landing = () =>
  home
    .replace(/<meta http-equiv="content-security-policy"[^>]*>/i, "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace("</head>", `<style>${still}\n${composition}</style></head>`);

// The site's own type and colours (landing/styles/site.css), on a white card.
const cardStyle = (background: string) => `:root { --ink: #000; --dim: #555; --sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: ${size.width}px; height: ${size.height}px; overflow: hidden; background: ${background}; font-family: var(--sans); color: var(--ink); -webkit-font-smoothing: antialiased; }
.brand { display: flex; align-items: center; gap: 14px; font-size: 30px; font-weight: 600; letter-spacing: -0.01em; }
.brand img { width: 52px; height: 52px; border-radius: 23%; }`;

const card = (style: string, body: string, background = "#fff") =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><style>${cardStyle(background)}\n${style}</style><body>${body}</body></html>`;

const brand = `<div class="brand"><img src="/__assets/icons/simple.png" alt="">${site.name}</div>`;

const legalCard = ({ title, note }: ShareCard) =>
  card(
    `main { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 26px; }
h1 { max-width: 760px; font-size: 104px; line-height: 1; font-weight: 700; letter-spacing: -0.035em; text-wrap: balance; }
p { max-width: 640px; font-size: 34px; color: var(--dim); text-wrap: balance; }
.pin { position: absolute; display: flex; flex-direction: column; align-items: center; gap: 8px; }
.pin img { object-fit: cover; border-radius: 26%; border: 5px solid #fff; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.08), 0 30px 50px -16px rgba(0, 0, 0, 0.42); }
.pin b { font-size: 17px; font-weight: 700; color: #1c1c1e; }
.pin span { font-size: 15px; color: #6e6e73; margin-top: -6px; }
.p1 { left: 70px; top: 330px; transform: rotate(-7deg); }
.p2 { right: 70px; top: 300px; transform: rotate(6deg); }`,
    `<main>${brand}<h1>${escapeHTML(title)}</h1><p>${escapeHTML(sentence(note))}</p></main>
<figure class="pin p1"><img src="/__assets/spots/tile-republique.jpg" width="150" height="150" alt=""><b>Place de la République</b><span>Paris</span></figure>
<figure class="pin p2"><img src="/__assets/spots/tile-kulturforum.jpg" width="140" height="140" alt=""><b>Kulturforum</b><span>Berlin</span></figure>`,
  );

// The cover's tile with its border and soft shadow. Its inside is the base's white or, for the frame, a transparent
// hole: every shadow is painted outside the box only, and the last one is the white page around it.
const tile = (inside: string) => {
  const { left, top, border, cover } = spotCardTile;
  const radius = spotCardTile.size * spotCardTile.radius - border;
  return `.tile { position: absolute; left: ${left + border}px; top: ${top + border}px; width: ${cover.size}px; height: ${cover.size}px; border-radius: ${radius}px; background: ${inside};
  box-shadow: 0 0 0 ${border}px #fff, 0 4px 8px ${border}px rgba(0, 0, 0, 0.08), 0 50px 80px ${border - 24}px rgba(0, 0, 0, 0.45), 0 0 0 ${size.width}px #fff; }`;
};

const { pill } = spotCardColumn;
// sips crops from the centre when the offset is 0, 0, so the pill is drawn clear of the corner.
const pillAt = { left: spotCardColumn.left, top: spotCardBrand.top };
const spotParts = {
  base: card(`${tile("#fff")}\n.brand { position: absolute; left: ${spotCardBrand.left}px; top: ${spotCardBrand.top}px; }`, `<div class="tile"></div>${brand}`),
  frame: card(tile("transparent"), `<div class="tile"></div>`, "transparent"),
  pill: card(
    `.pill { position: absolute; left: ${pillAt.left}px; top: ${pillAt.top}px; width: ${pill.width}px; height: ${pill.height}px; border-radius: 999px; background: #000; color: #fff; font-size: 24px; font-weight: 600; line-height: ${pill.height}px; text-align: center; }`,
    `<div class="pill">${pill.text}</div>`,
    "transparent",
  ),
};

type Shot = {
  name: string;
  page: () => string;
  scale: number;
  outputs: string[];
  format: { jpeg: number } | "png";
  transparent?: boolean;
  crop?: { left: number; top: number; width: number; height: number };
};

const partOutput = (part: string) => path.join(shareDirectory, "spot-card", path.basename(part));

const shots: Shot[] = [
  // 1.5×, not 2×: WhatsApp drops link previews over ~300 KB.
  { name: "share", page: landing, scale: 1.5, format: { jpeg: 80 }, outputs: [path.join(shareDirectory, "home.jpg")] },
  { name: "readme", page: landing, scale: 2, format: { jpeg: 82 }, outputs: [path.join(root, "../../.github/assets/hero.jpg"), ...process.argv.slice(2)] },
  ...shareCards.map((share) => ({ name: share.name, page: () => legalCard(share), scale: 1.5, format: { jpeg: 82 }, outputs: [path.join(shareDirectory, `${share.name}.jpg`)] })),
  // The spot card's parts are drawn at the card's own size: Images composes them pixel for pixel.
  { name: "spot-base", page: () => spotParts.base, scale: 1, format: { jpeg: 92 }, outputs: [partOutput(spotCardParts.base)] },
  {
    name: "spot-frame",
    page: () => spotParts.frame,
    scale: 1,
    format: "png",
    transparent: true,
    crop: { left: spotCardTile.left, top: spotCardTile.top, width: spotCardTile.size, height: spotCardTile.size },
    outputs: [partOutput(spotCardParts.frame)],
  },
  {
    name: "spot-pill",
    page: () => spotParts.pill,
    scale: 1,
    format: "png",
    transparent: true,
    crop: { ...pillAt, width: pill.width, height: pill.height },
    outputs: [partOutput(spotCardParts.pill)],
  },
];

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const shot = shots.find((candidate) => pathname === `/__${candidate.name}`);
    if (shot) return new Response(shot.page(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    const file = pathname.startsWith("/__assets/")
      ? Bun.file(path.join(landingAssets, pathname.slice("/__assets/".length)))
      : Bun.file(path.join(landingBuild, pathname.endsWith("/") ? `${pathname}index.html` : pathname));
    return (await file.exists()) ? new Response(file) : new Response("Not found", { status: 404 });
  },
});

function run(command: string[]) {
  const result = Bun.spawnSync(command);
  if (result.exitCode !== 0) throw new Error(`${command[0]} failed: ${result.stderr.toString()}`);
}

const directory = await mkdtemp(path.join(tmpdir(), "share-images-"));
try {
  await mkdir(path.join(shareDirectory, "spot-card"), { recursive: true });
  for (const shot of shots) {
    let png = path.join(directory, `${shot.name}.png`);
    // Async: a sync spawn would block the server Chrome is loading the page from.
    const render = Bun.spawn([
      chrome,
      "--headless",
      "--hide-scrollbars",
      `--window-size=${size.width},${size.height}`,
      `--force-device-scale-factor=${shot.scale}`,
      ...(shot.transparent ? ["--default-background-color=00000000"] : []),
      "--virtual-time-budget=5000",
      `--screenshot=${png}`,
      `${server.url}__${shot.name}`,
    ], { stdout: "ignore", stderr: "pipe" });
    if ((await render.exited) !== 0) throw new Error(`Chrome failed: ${await new Response(render.stderr).text()}`);
    if (shot.crop) {
      const { left, top, width, height } = shot.crop;
      const cropped = path.join(directory, `${shot.name}-cropped.png`);
      run(["sips", "--cropToHeightWidth", String(height), String(width), "--cropOffset", String(top), String(left), png, "--out", cropped]);
      png = cropped;
    }
    let output = png;
    if (shot.format !== "png") {
      output = path.join(directory, `${shot.name}.jpg`);
      run(["sips", "-s", "format", "jpeg", "-s", "formatOptions", String(shot.format.jpeg), png, "--out", output]);
    }
    const bytes = await readFile(output);
    for (const destination of shot.outputs) await writeFile(destination, bytes);
    console.log(`${shot.name}: ${Math.round(bytes.length / 1024)} KB → ${shot.outputs.map((file) => path.relative(root, file)).join(", ")}`);
  }
} finally {
  await server.stop();
  await rm(directory, { recursive: true, force: true });
}
