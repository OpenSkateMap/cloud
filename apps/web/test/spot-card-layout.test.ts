import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { renderFontMetrics } from "../scripts/font-metrics.ts";
import { spotCardPartFiles } from "../site/cards.ts";
import { imageSize } from "./image-size.ts";
import { SpotCardSchema } from "../src/index.ts";
import { fitTitle, inkWidth, layOutSpotCard, measure, spotCardColumn, spotCardParts, spotCardSize, spotCardTile, spotKinds } from "../site/spot-card-layout.ts";

const { width } = spotCardColumn;

describe("spot card layout", () => {
  test("the committed metrics match the fonts", async () => {
    expect(await readFile(path.join(import.meta.dirname, "../site/font-metrics.ts"), "utf8")).toBe(await renderFontMetrics());
  });

  test("the committed parts are drawn at the sizes the Worker places them at", async () => {
    const sizes = Object.fromEntries(await Promise.all(spotCardPartFiles.map(async ({ part, source }) => [part, await imageSize(source)] as const)));
    expect(sizes).toEqual({
      [spotCardParts.base]: spotCardSize,
      [spotCardParts.frame]: { width: spotCardTile.size, height: spotCardTile.size },
      [spotCardParts.pill]: { width: spotCardColumn.pill.width, height: spotCardColumn.pill.height },
      ...Object.fromEntries(spotKinds.map((kind) => [spotCardParts.empty(kind), { width: spotCardTile.cover.size, height: spotCardTile.cover.size }])),
    });
  });

  test("the model predicts the boxes Cloudflare Images draws", () => {
    // Measured from Images' `.text()` output (PNG width × height) on 2026-11-15; kerning-free strings. Images sets
    // Inter at its advances; kerned pairs only come out narrower than the model, so fitted text still fits.
    const measured: [font: "display" | "text", text: string, size: number, width: number, height: number][] = [
      ["display", "HHHHHHHH", 84, 474, 61],
      ["display", "HHHHHHHH", 168, 948, 123],
      ["display", "Hg", 168, 204, 157],
      ["display", "ÄH", 168, 232, 160],
      ["display", "H H", 168, 260, 123],
      ["display", "H,", 168, 145, 148],
      ["display", "Площадь", 84, 370, 75],
      ["text", "Plaza · London", 34, 212, 25],
      ["text", "Street · Copenhagen", 34, 302, 32],
      ["text", "HHHHHHHH", 68, 377, 50],
    ];
    for (const [font, text, size, expectedWidth, expectedHeight] of measured) {
      const ink = measure(font, text, size);
      expect(Math.abs(ink.right - ink.left - expectedWidth)).toBeLessThanOrEqual(2.5);
      expect(Math.abs(ink.top - ink.bottom - expectedHeight)).toBeLessThanOrEqual(2.5);
    }
  });

  test("a short name is one big line; two words that don't fit break evenly", () => {
    expect(fitTitle("MACBA", width)).toEqual({ size: 84, lines: ["MACBA"] });
    expect(fitTitle("Southbank Undercroft", width)).toEqual({ size: 84, lines: ["Southbank", "Undercroft"] });
    expect(fitTitle("Площадь Ленина", width)).toEqual({ size: 84, lines: ["Площадь", "Ленина"] });
  });

  test("a long name shrinks to two lines and ends at a whole word", () => {
    const title = fitTitle("The Old Concrete Banks Behind the Abandoned Train Station at Midnight", width);
    expect(title).toEqual({ size: 52, lines: ["The Old Concrete Banks", "Behind the Abandoned…"] });
    for (const line of title.lines) expect(inkWidth("display", line, title.size)).toBeLessThanOrEqual(width);
    expect(fitTitle("Kunstgewerbemuseum", width)).toEqual({ size: 52, lines: ["Kunstgewerbemuseum"] });
  });

  test("one endless word is cut to fit; characters the font lacks are dropped", () => {
    const title = fitTitle("Supercalifragilisticexpialidociousbowlwithnoendinsightatall", width);
    expect(title.lines).toHaveLength(1);
    expect(title.lines[0]?.endsWith("…")).toBe(true);
    expect(inkWidth("display", title.lines[0] ?? "", title.size)).toBeLessThanOrEqual(width);
    expect(fitTitle("Ledges 🛹 東京", width).lines).toEqual(["Ledges"]);
  });

  test("the name, the note and the pill stack without touching, accents included, inside the column", () => {
    for (const name of ["Plaça dels Àngels Ledges", "Southbank Undercroft", "Ålesund Ön Quay", "MACBA", "The Old Concrete Banks Behind the Abandoned Train Station at Midnight"]) {
      const { text, pill } = layOutSpotCard({ name, kind: "street", city: "Barcelona" });
      const boxes = text.map((run) => {
        const ink = measure(run.font, run.text, run.size);
        return { top: run.top, bottom: run.top + ink.top - ink.bottom, left: run.left, right: run.left + ink.right - ink.left };
      });
      boxes.push({ top: pill.top, bottom: pill.top + spotCardColumn.pill.height, left: pill.left, right: pill.left + spotCardColumn.pill.width });
      for (let index = 1; index < boxes.length; index++) expect(boxes[index - 1]!.bottom).toBeLessThan(boxes[index]!.top);
      for (const box of boxes) {
        expect(box.left).toBeGreaterThanOrEqual(spotCardColumn.left - 2);
        expect(box.right).toBeLessThanOrEqual(spotCardColumn.left + width);
        expect(box.right).toBeLessThan(spotCardTile.left);
      }
      expect(boxes[0]!.top).toBeGreaterThan(0);
      expect(boxes.at(-1)!.bottom).toBeLessThan(spotCardSize.height);
    }
  });

  test("the block is centred on the card, so a one-line name sits lower than a two-line one", () => {
    const one = layOutSpotCard({ name: "MACBA", kind: "plaza", city: "Barcelona" });
    const two = layOutSpotCard({ name: "Southbank Undercroft", kind: "plaza", city: "London" });
    expect(one.text[0]!.top).toBeGreaterThan(two.text[0]!.top);
    expect(Math.abs(two.text[0]!.top + (two.pill.top + spotCardColumn.pill.height) - spotCardSize.height)).toBeLessThan(40);
  });

  test("the note is kind · city, cut to the column", () => {
    expect(layOutSpotCard({ name: "MACBA", kind: "plaza", city: "Barcelona" }).text.at(-1)?.text).toBe("Plaza · Barcelona");
    expect(layOutSpotCard({ name: "MACBA", kind: "diy", city: null }).text.at(-1)?.text).toBe("DIY");
    const long = layOutSpotCard({ name: "MACBA", kind: "street", city: "Llanfairpwllgwyngyll Gogerychwyrndrobwll Llantysilio Gogogoch" }).text.at(-1)!;
    expect(long.text.endsWith("…")).toBe(true);
    expect(inkWidth("text", long.text, long.size)).toBeLessThanOrEqual(width);
  });

  test("the site's spot card and kinds match the API's contract", async () => {
    const spec = JSON.parse(await readFile(path.join(import.meta.dirname, "../../api/openapi.json"), "utf8")) as {
      components: { schemas: Record<string, { properties?: Record<string, unknown>; enum?: string[] }> };
    };
    const { SpotCard, SpotKind } = spec.components.schemas;
    expect(Object.keys(SpotCardSchema.shape).sort()).toEqual(Object.keys(SpotCard?.properties ?? {}).sort());
    expect(spotKinds.toSorted()).toEqual<string[]>((SpotKind?.enum ?? []).toSorted());
  });
});
