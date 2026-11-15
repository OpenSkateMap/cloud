import { fontMetrics } from "./font-metrics.ts";

export type FontName = keyof typeof fontMetrics;

export type TextRun = { font: FontName; text: string; size: number; color: string; left: number; top: number };

export const spotCardSize = { width: 1200, height: 630 } as const;

// Images refuses #rrggbbaa (error 9432), so the note's colour is rgba().
export const spotCardColors = { paper: "#f4f1ea", note: "rgba(244,241,234,0.72)" } as const;

export const spotCardDesign = 1;

export const spotCardParts = {
  frame: "cards/spot/frame.png",
  grain: "cards/spot/grain.png",
  base: (kind: string) => `cards/spot/${kind}.jpg`,
} as const;

export const spotCardFrame = {
  margin: 64,
  bottom: 60,
  pill: { text: "See the spot", fontSize: 28, lineHeight: 34, paddingX: 30, paddingY: 16 },
  get pillWidth() {
    return Math.ceil(measure("text", this.pill.text, this.pill.fontSize).advance) + this.pill.paddingX * 2;
  },
  get pillTop() {
    return spotCardSize.height - this.bottom - this.pill.lineHeight - this.pill.paddingY * 2;
  },
  get pillBaseline() {
    const { unitsPerEm, ascender, descender } = fontMetrics.text;
    const scale = this.pill.fontSize / unitsPerEm;
    return this.pillTop + this.pill.paddingY + (this.pill.lineHeight - (ascender - descender) * scale) / 2 + ascender * scale;
  },
} as const;

/** Images sets text slightly looser than the font's advances: measured at 0.0145 em per glyph (see the tests). */
const tracking = 0.0145;

const titleSizes = { largest: 156, smallest: 100, step: 4 } as const;
const titleLeading = 0.86;
const titleClearance = 0.05;
const noteSize = 30;
const titleGap = 24;

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
  const text = drawable("display", name.toLocaleUpperCase("en"));
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

export function layOutSpotCard(content: SpotCardContent): TextRun[] {
  const { width } = spotCardSize;
  const { margin, pillWidth } = spotCardFrame;
  const noteText = truncate("text", drawable("text", [kindTitles[content.kind], content.city].filter(Boolean).join(" · ")), noteSize, width - margin * 2 - pillWidth - 32);
  const noteInk = measure("text", noteText, noteSize);
  const noteBaseline = spotCardFrame.pillBaseline;
  const title = fitTitle(content.name, width - margin * 2);
  const inks = title.lines.map((line) => measure("display", line, title.size));
  const baselines = [spotCardFrame.pillTop - titleGap];
  for (let index = inks.length - 1; index > 0; index--) {
    const below = inks[index];
    const above = inks[index - 1];
    const pitch = Math.max(title.size * titleLeading, (below?.top ?? 0) - (above?.bottom ?? 0) + title.size * titleClearance);
    baselines.unshift((baselines[0] ?? 0) - pitch);
  }
  const runs: TextRun[] = title.lines.map((line, index) => {
    const ink = inks[index] ?? measure("display", line, title.size);
    const baseline = baselines[index] ?? 0;
    return { font: "display", text: line, size: title.size, color: spotCardColors.paper, left: Math.round(margin + ink.left), top: Math.round(baseline - ink.top) };
  });
  if (noteText) {
    runs.push({ font: "text", text: noteText, size: noteSize, color: spotCardColors.note, left: Math.round(margin + noteInk.left), top: Math.round(noteBaseline - noteInk.top) });
  }
  return runs.filter((run) => run.text.length > 0);
}

export const spotKinds = ["street", "park", "diy", "plaza"] as const;

export const kindTitles = { street: "Street", park: "Park", diy: "DIY", plaza: "Plaza" } as const satisfies Record<SpotKind, string>;

export const kindColors = { street: "#0a84ff", park: "#30d158", diy: "#ff9f0a", plaza: "#bf5af2" } as const satisfies Record<SpotKind, string>;
