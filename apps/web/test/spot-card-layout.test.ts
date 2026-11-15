import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { renderFontMetrics } from "../scripts/font-metrics.ts";
import { SpotCardSchema } from "../src/index.ts";
import { fitTitle, inkWidth, layOutSpotCard, measure, spotCardFrame, spotCardSize, spotKinds } from "../site/spot-card-layout.ts";

const width = spotCardSize.width - spotCardFrame.margin * 2;

describe("spot card layout", () => {
  test("the committed metrics match the fonts", async () => {
    expect(await readFile(path.join(import.meta.dirname, "../site/font-metrics.ts"), "utf8")).toBe(await renderFontMetrics());
  });

  test("the model predicts the boxes Cloudflare Images draws", () => {
    // Measured from Images' `.text()` output (PNG width × height) on 2026-10-10; kerning-free strings.
    const measured: [font: "display" | "text", text: string, size: number, width: number, height: number][] = [
      ["display", "HAMBURGÄgjpq", 100, 569, 111],
      ["display", "HAMBURGÄgjpq", 200, 1136, 220],
      ["display", "HHHHHHHH", 200, 781, 146],
      ["display", "Hg", 200, 183, 180],
      ["display", "ÄH", 200, 194, 186],
      ["display", "H H", 200, 216, 146],
      ["display", "H,", 200, 135, 179],
      ["text", "Plaza · London", 30, 201, 22],
      ["text", "Street · Copenhagen", 30, 287, 27],
    ];
    for (const [font, text, size, expectedWidth, expectedHeight] of measured) {
      const ink = measure(font, text, size);
      expect(Math.abs(ink.right - ink.left - expectedWidth)).toBeLessThanOrEqual(2.5);
      expect(Math.abs(ink.top - ink.bottom - expectedHeight)).toBeLessThanOrEqual(2.5);
    }
  });

  test("a short name is one big line; two words that don't fit break evenly", () => {
    expect(fitTitle("MACBA", width)).toEqual({ size: 156, lines: ["MACBA"] });
    expect(fitTitle("Southbank Undercroft", width)).toEqual({ size: 156, lines: ["SOUTHBANK", "UNDERCROFT"] });
  });

  test("a long name shrinks to two lines and ends at a whole word", () => {
    const title = fitTitle("The Old Concrete Banks Behind the Abandoned Train Station at Midnight", width);
    expect(title.size).toBe(100);
    expect(title.lines).toEqual(["THE OLD CONCRETE BANKS", "BEHIND THE ABANDONED…"]);
    for (const line of title.lines) expect(inkWidth("display", line, title.size)).toBeLessThanOrEqual(width);
  });

  test("one endless word is cut to fit; characters the font lacks are dropped", () => {
    const title = fitTitle("Supercalifragilisticexpialidociousbowlwithnoendinsightatall", width);
    expect(title.lines).toHaveLength(1);
    expect(title.lines[0]?.endsWith("…")).toBe(true);
    expect(inkWidth("display", title.lines[0] ?? "", title.size)).toBeLessThanOrEqual(width);
    expect(fitTitle("Ledges 🛹 東京", width).lines).toEqual(["LEDGES"]);
  });

  test("lines never touch, accents included, and the name stays clear of the pill", () => {
    for (const name of ["Plaça dels Àngels Ledges", "Southbank Undercroft", "Ålesund Ön Quay"]) {
      const runs = layOutSpotCard({ name, kind: "street", city: "Barcelona" });
      const lines = runs.filter((run) => run.font === "display");
      for (let index = 1; index < lines.length; index++) {
        const above = lines[index - 1]!;
        const ink = measure("display", above.text, above.size);
        expect(above.top + (ink.top - ink.bottom)).toBeLessThan(lines[index]!.top);
      }
      const last = lines.at(-1)!;
      const lastInk = measure("display", last.text, last.size);
      expect(last.top + lastInk.top).toBeLessThanOrEqual(spotCardFrame.pillTop);
      for (const run of runs) expect(run.left).toBeGreaterThanOrEqual(spotCardFrame.margin - 2);
    }
  });

  test("the note is kind · city, cut short of the pill", () => {
    expect(layOutSpotCard({ name: "MACBA", kind: "plaza", city: "Barcelona" }).at(-1)?.text).toBe("Plaza · Barcelona");
    expect(layOutSpotCard({ name: "MACBA", kind: "diy", city: null }).at(-1)?.text).toBe("DIY");
    const long = layOutSpotCard({ name: "MACBA", kind: "street", city: "Llanfairpwllgwyngyll Gogerychwyrndrobwll Llantysilio Gogogoch" }).at(-1)!;
    expect(long.text.endsWith("…")).toBe(true);
    expect(inkWidth("text", long.text, long.size)).toBeLessThanOrEqual(width - spotCardFrame.pillWidth - 32);
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
