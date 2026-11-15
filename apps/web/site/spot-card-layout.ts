import { fontMetrics } from "./font-metrics.ts";

export type FontName = keyof typeof fontMetrics;

export type TextRun = { font: FontName; text: string; size: number; color: string; left: number; top: number };

export const spotCardSize = { width: 1200, height: 630 } as const;

export const spotCardColors = { ink: "#000000", note: "#555555" } as const;

export const spotCardDesign = 2;

export const spotCardParts = {
  base: "cards/spot/base.jpg",
  frame: "cards/spot/frame.png",
  pill: "cards/spot/pill.png",
} as const;

/** The cover's rounded tile, right of the text: the frame part covers `left, top, size`, the cover fills the inside of the border. */
export const spotCardTile = {
  left: 690,
  top: 105,
  size: 420,
  border: 10,
  radius: 0.26,
  get cover() {
    return { left: this.left + this.border, top: this.top + this.border, size: this.size - this.border * 2 };
  },
} as const;

export const spotCardBrand = { left: 80, top: 64 } as const;

/** The text column: the name, "Kind · City", then the pill part, centred as one block. */
export const spotCardColumn = { left: 80, width: 600, titleGap: 22, pillGap: 40, pill: { text: "See the spot", width: 188, height: 60 } } as const;

/** Images sets text slightly looser than the font's advances: measured at 0.0145 em per glyph (see the tests). */
const tracking = 0.0145;

const titleSizes = { largest: 84, smallest: 52, step: 4 } as const;
const titleLeading = 1.02;
const titleClearance = 0.04;
const noteSize = 34;

type Ink = { left: number; right: number; top: number; bottom: number; advance: number };

export function measure(font: FontName, text: string, size: number): Ink {
  const { unitsPerEm, glyphs } = fontMetrics[font];
  const scale = size / unitsPerEm;
  let pen = 0;
  const ink = { left: Infinity, right: -Infinity, top: -Infinity, bottom: Infinity };
  for (const character of text) {
    const [advance = 0, xMin, xMax, yMin, yMax] = glyphs[character] ?? [];
    if (xMin !== undefined && xMax !== undefined && yMin !== undefined && yMax !== undefined) {
      ink.left = Math.min(ink.left, pen + xMin * scale);
      ink.right = Math.max(ink.right, pen + xMax * scale);
      ink.top = Math.max(ink.top, yMax * scale);
      ink.bottom = Math.min(ink.bottom, yMin * scale);
    }
    pen += advance * scale + tracking * size;
  }
  if (ink.left === Infinity) return { left: 0, right: 0, top: 0, bottom: 0, advance: pen };
  return { ...ink, advance: pen - tracking * size };
}

export const inkWidth = (font: FontName, text: string, size: number) => {
  const ink = measure(font, text, size);
  return ink.right - ink.left;
};

export const drawable = (font: FontName, text: string) =>
  [...text]
    .filter((character) => character in fontMetrics[font].glyphs)
    .join("")
    .replace(/\s+/g, " ")
    .trim();

function truncate(font: FontName, text: string, size: number, width: number) {
  if (inkWidth(font, text, size) <= width) return text;
  const fits = (kept: string) => inkWidth(font, `${kept}…`, size) <= width;
  const words = text.split(" ");
  for (let count = words.length - 1; count > 0; count--) {
    const kept = words.slice(0, count).join(" ");
    if (fits(kept)) return `${kept}…`;
  }
  let kept = [...text];
  while (kept.length > 0 && !fits(kept.join("").trimEnd())) kept = kept.slice(0, -1);
  return `${kept.join("").trimEnd()}…`;
}

export function fitTitle(name: string, width: number): { size: number; lines: string[] } {
  const text = drawable("display", name);
  const words = text.split(" ");
  for (let size: number = titleSizes.largest; size >= titleSizes.smallest; size -= titleSizes.step) {
    if (inkWidth("display", text, size) <= width) return { size, lines: [text] };
    let best: { lines: string[]; widest: number } | undefined;
    for (let split = 1; split < words.length; split++) {
      const lines = [words.slice(0, split).join(" "), words.slice(split).join(" ")];
      const widest = Math.max(...lines.map((line) => inkWidth("display", line, size)));
      if (widest <= width && (best === undefined || widest < best.widest)) best = { lines, widest };
    }
    if (best) return { size, lines: best.lines };
  }
  const size = titleSizes.smallest;
  let first = "";
  let rest = text;
  for (const word of words) {
    const candidate = first ? `${first} ${word}` : word;
    if (inkWidth("display", candidate, size) > width) break;
    first = candidate;
    rest = rest.slice(word.length).trimStart();
  }
  if (!first) return { size, lines: [truncate("display", text, size, width)] };
  return { size, lines: rest ? [first, truncate("display", rest, size, width)] : [first] };
}

export type SpotCardContent = { name: string; kind: SpotKind; city: string | null };

export type SpotKind = (typeof spotKinds)[number];

export type SpotCardLayout = { text: TextRun[]; pill: { left: number; top: number } };

/** Where a line's baseline sits in a CSS line box of `height`: the font's ascent plus half the leading. */
function baselineIn(font: FontName, size: number, height: number) {
  const { unitsPerEm, ascender, descender } = fontMetrics[font];
  const scale = size / unitsPerEm;
  return (height - (ascender - descender) * scale) / 2 + ascender * scale;
}

export function layOutSpotCard(content: SpotCardContent): SpotCardLayout {
  const { left, width, titleGap, pillGap, pill } = spotCardColumn;
  const title = fitTitle(content.name, width);
  const inks = title.lines.map((line) => measure("display", line, title.size));
  const pitch = title.size * titleLeading;
  const tops = [0];
  for (let index = 1; index < inks.length; index++) {
    const clear = (inks[index]?.top ?? 0) - (inks[index - 1]?.bottom ?? 0) + title.size * titleClearance;
    tops.push((tops[index - 1] ?? 0) + Math.max(pitch, clear));
  }
  const titleHeight = (tops.at(-1) ?? 0) + pitch;
  const { unitsPerEm, ascender, descender } = fontMetrics.text;
  const noteHeight = ((ascender - descender) / unitsPerEm) * noteSize;
  const top = (spotCardSize.height - (titleHeight + titleGap + noteHeight + pillGap + pill.height)) / 2;

  const text: TextRun[] = title.lines.map((line, index) => {
    const ink = inks[index] ?? measure("display", line, title.size);
    const baseline = top + (tops[index] ?? 0) + baselineIn("display", title.size, pitch);
    return { font: "display", text: line, size: title.size, color: spotCardColors.ink, left: Math.round(left + ink.left), top: Math.round(baseline - ink.top) };
  });
  const noteTop = top + titleHeight + titleGap;
  const noteText = truncate("text", drawable("text", [kindTitles[content.kind], content.city].filter(Boolean).join(" · ")), noteSize, width);
  if (noteText) {
    const ink = measure("text", noteText, noteSize);
    const baseline = noteTop + baselineIn("text", noteSize, noteHeight);
    text.push({ font: "text", text: noteText, size: noteSize, color: spotCardColors.note, left: Math.round(left + ink.left), top: Math.round(baseline - ink.top) });
  }
  return { text: text.filter((run) => run.text.length > 0), pill: { left, top: Math.round(noteTop + noteHeight + pillGap) } };
}

export const spotKinds = ["street", "park", "diy", "plaza"] as const;

export const kindTitles = { street: "Street", park: "Park", diy: "DIY", plaza: "Plaza" } as const satisfies Record<SpotKind, string>;

export const kindColors = { street: "#0a84ff", park: "#30d158", diy: "#ff9f0a", plaza: "#bf5af2" } as const satisfies Record<SpotKind, string>;
