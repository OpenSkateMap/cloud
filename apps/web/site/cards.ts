import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { Resvg } from "@resvg/resvg-js";
import jpeg from "jpeg-js";
import satori from "satori";
import { site } from "./site.ts";
import { kindColors, spotCardColors, spotCardFrame, spotCardParts, spotCardSize as cardSize } from "./spot-card-layout.ts";

export type Card = {
  name: string;
  lines: readonly string[];
  note: string;
  action?: string;
};

export type RenderedCard = { file: string; url: string; alt: string; bytes: Uint8Array; width?: number; height?: number };

const shareDirectory = path.join(import.meta.dirname, "share");

/** A share image rendered from the site itself (scripts/share-images.ts), fingerprinted like the drawn cards. */
export async function sharedCard(name: string, alt: string, size: { width: number; height: number }): Promise<RenderedCard> {
  const bytes = new Uint8Array(await readFile(path.join(shareDirectory, `${name}.jpg`)));
  const file = `cards/${name}.${createHash("sha256").update(bytes).digest("hex").slice(0, 10)}.jpg`;
  return { file, url: `${site.origin}/${file}`, alt, bytes, ...size };
}

/** JPEG keeps the grain far under WhatsApp's ~300 KB preview limit; noise in a PNG doesn't compress. */
const jpegQuality = 84;

const fontDirectory = path.join(import.meta.dirname, "../fonts");

const fontFaces = [
  { name: "Display", file: "MonaSansDisplayCondensed-Black.ttf", weight: 900 },
  { name: "Wordmark", file: "MonaSansExpanded-SemiBold.ttf", weight: 600 },
  { name: "Text", file: "MonaSans-Medium.ttf", weight: 500 },
] as const;

let loadedFonts: ReturnType<typeof loadFonts> | undefined;
function loadFonts() {
  return Promise.all(
    fontFaces.map(async ({ name, file, weight }) => ({
      name,
      weight,
      style: "normal" as const,
      data: await readFile(path.join(fontDirectory, file)),
    })),
  );
}

type Element = { type: "div"; props: { style: Style; children?: string | Element[] }; key: null };
type Style = Record<string, string | number>;

const div = (style: Style, children?: string | (Element | undefined)[]): Element => ({
  type: "div",
  props: {
    style: { display: "flex", ...style },
    ...(children === undefined
      ? {}
      : { children: typeof children === "string" ? children : children.filter((child) => child !== undefined) }),
  },
  key: null,
});

const { paper } = spotCardColors;

function layout(card: Card): Element {
  return div(
    {
      flexDirection: "column",
      justifyContent: "space-between",
      width: "100%",
      height: "100%",
      padding: "56px 64px 60px",
      backgroundColor: "#0a0a0a",
      backgroundImage:
        "radial-gradient(circle at 100% -12%, rgba(255,186,110,0.95) 0%, rgba(255,128,40,0.55) 14%, rgba(214,82,18,0.16) 34%, rgba(10,10,10,0) 56%)",
    },
    [
      div({ fontFamily: "Wordmark", fontSize: 34, letterSpacing: 0.3, color: paper }, site.name),
      div({ alignItems: "flex-end", justifyContent: "space-between" }, [
        div({ flexDirection: "column" }, [
          div(
            { flexDirection: "column", fontFamily: "Display", fontSize: 156, lineHeight: 0.84, letterSpacing: -2, color: paper, textTransform: "uppercase" },
            card.lines.map((line) => div({}, line)),
          ),
          div({ marginTop: 26, fontFamily: "Text", fontSize: 30, color: "rgba(244,241,234,0.62)" }, card.note),
        ]),
        card.action === undefined
          ? undefined
          : div(
              { flexShrink: 0, whiteSpace: "nowrap", marginLeft: 32, padding: "16px 30px", borderRadius: 999, background: paper, color: "#0b0b0b", fontFamily: "Text", fontSize: 28 },
              card.action,
            ),
      ]),
    ],
  );
}

const grain = `<defs><filter id="grain" x="0" y="0" width="${cardSize.width}" height="${cardSize.height}" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="11" stitchTiles="stitch"/>
<feColorMatrix type="matrix" values="0.9 0.9 0.9 0 -0.85  0.9 0.9 0.9 0 -0.85  0.9 0.9 0.9 0 -0.85  0 0 0 0 1"/>
</filter></defs><rect width="${cardSize.width}" height="${cardSize.height}" filter="url(#grain)" style="mix-blend-mode:soft-light"/>`;

export async function renderCard(card: Card): Promise<RenderedCard> {
  const svg = await satori(layout(card), { ...cardSize, fonts: await (loadedFonts ??= loadFonts()) });
  const image = new Resvg(svg.replace(/<\/svg>\s*$/, `${grain}</svg>`), { font: { loadSystemFonts: false } }).render();
  const encoded = jpeg.encode({ data: image.pixels, width: image.width, height: image.height }, jpegQuality).data;
  const bytes = new Uint8Array(encoded);
  const file = `cards/${card.name}.${createHash("sha256").update(bytes).digest("hex").slice(0, 10)}.jpg`;
  const headline = card.lines.join(" ");
  const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);
  const alt = `${site.name}: ${sentence(headline)} ${sentence(card.note)}`;
  return { file, url: `${site.origin}/${file}`, alt, bytes };
}

const rgba = (hex: string, alpha: number) =>
  `rgba(${[1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16)).join(",")},${alpha})`;

const ink = "rgba(8,8,8,";

function spotFrame(): Element {
  const { margin, bottom, pill } = spotCardFrame;
  return div({ position: "relative", width: "100%", height: "100%" }, [
    div({ position: "absolute", top: 0, left: 0, width: "100%", height: 230, backgroundImage: `linear-gradient(180deg, ${ink}0.62) 0%, ${ink}0.28) 45%, ${ink}0) 100%)` }),
    div({
      position: "absolute",
      bottom: 0,
      left: 0,
      width: "100%",
      height: 520,
      backgroundImage: `linear-gradient(0deg, ${ink}0.95) 0%, ${ink}0.86) 26%, ${ink}0.55) 52%, ${ink}0.18) 78%, ${ink}0) 100%)`,
    }),
    div({ position: "absolute", top: 56, left: margin, fontFamily: "Wordmark", fontSize: 34, letterSpacing: 0.3, color: paper }, site.name),
    div(
      {
        position: "absolute",
        right: margin,
        bottom,
        whiteSpace: "nowrap",
        padding: `${pill.paddingY}px ${pill.paddingX}px`,
        lineHeight: `${pill.lineHeight}px`,
        borderRadius: 999,
        background: spotCardColors.paper,
        color: "#0b0b0b",
        fontFamily: "Text",
        fontSize: pill.fontSize,
      },
      pill.text,
    ),
  ]);
}

const spotBase = (color: string): Element =>
  div({
    width: "100%",
    height: "100%",
    backgroundColor: "#0a0a0a",
    backgroundImage: `radial-gradient(circle at 100% -12%, ${rgba(color, 0.9)} 0%, ${rgba(color, 0.5)} 16%, ${rgba(color, 0.14)} 36%, rgba(10,10,10,0) 58%)`,
  });

function encodePng(width: number, height: number, pixels: Uint8Array) {
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let row = 0; row < height; row++) raw.set(pixels.subarray(row * width * 4, (row + 1) * width * 4), row * (width * 4 + 1) + 1);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())];
  const png = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

function grainTile(side = 256) {
  let seed = 0x2f6e2b1;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0xffffffff;
  };
  const pixels = new Uint8Array(side * side * 4);
  for (let index = 0; index < side * side; index++) {
    const sample = (random() + random() + random() - 1.5) * 2;
    const value = sample > 0 ? 255 : 0;
    pixels.set([value, value, value, Math.min(Math.round(Math.abs(sample) * 26), 64)], index * 4);
  }
  return encodePng(side, side, pixels);
}

async function rasterize(element: Element) {
  const svg = await satori(element, { ...cardSize, fonts: await (loadedFonts ??= loadFonts()) });
  return new Resvg(svg, { font: { loadSystemFonts: false } }).render();
}

export async function renderSpotCardParts(): Promise<Record<string, Uint8Array>> {
  const parts: Record<string, Uint8Array> = {
    [spotCardParts.frame]: new Uint8Array((await rasterize(spotFrame())).asPng()),
    [spotCardParts.grain]: grainTile(),
  };
  for (const [kind, color] of Object.entries(kindColors)) {
    const image = await rasterize(spotBase(color));
    parts[spotCardParts.base(kind)] = new Uint8Array(jpeg.encode({ data: image.pixels, width: image.width, height: image.height }, 90).data);
  }
  return parts;
}

