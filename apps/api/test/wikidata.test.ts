import { describe, expect, test } from "bun:test";
import { completeNames, LOOKUP_USER_AGENT, wikidataCityNames, wikidataLabels } from "../src/lib/wikidata.ts";

const entity = (id: string, labels: Record<string, string>) => ({
  entities: { [id]: { id, labels: Object.fromEntries(Object.entries(labels).map(([language, value]) => [language, { language, value }])) } },
});

const answering = (status: number, body: unknown) => {
  const asked: { url: string; userAgent: string | null }[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    asked.push({ url, userAgent: new Headers(init?.headers).get("User-Agent") });
    return new Response(JSON.stringify(body), { status });
  };
  return { asked, fetcher };
};

describe("wikidataLabels", () => {
  test("asks for the item's data as a named client, and keeps the apps' languages with Chinese by script", async () => {
    const wikidata = answering(200, entity("Q26793", { en: "Bergen", nb: "Bergen", ru: "Берген", "zh-hans": "卑尔根", "zh-hant": "卑爾根", zh: "卑爾根" }));
    const labels = await wikidataLabels("Q26793", wikidata.fetcher);
    expect(labels._unsafeUnwrap()).toEqual({ en: "Bergen", ru: "Берген", "zh-Hans": "卑尔根", "zh-Hant": "卑爾根" });
    expect(wikidata.asked).toEqual([{ url: "https://www.wikidata.org/wiki/Special:EntityData/Q26793.json", userAgent: LOOKUP_USER_AGENT }]);
  });

  test("a merged item answers under the item it was merged into", async () => {
    const wikidata = answering(200, entity("Q656", { de: "Sankt Petersburg" }));
    expect((await wikidataLabels("Q123456789", wikidata.fetcher))._unsafeUnwrap()).toEqual({ de: "Sankt Petersburg" });
  });

  test("an unknown item or an unreadable answer is a failure, never empty names", async () => {
    expect((await wikidataLabels("Q1", answering(404, {}).fetcher))._unsafeUnwrapErr()).toEqual({ kind: "unreachable", service: "wikidata", status: 404 });
    expect((await wikidataLabels("Q1", answering(200, { entities: {} }).fetcher))._unsafeUnwrapErr()).toEqual({ kind: "unreadable", service: "wikidata" });
    const offline = async () => {
      throw new TypeError("fetch failed");
    };
    expect((await wikidataLabels("Q1", offline))._unsafeUnwrapErr()).toEqual({ kind: "unreachable", service: "wikidata" });
  });
});

describe("completeNames", () => {
  test("fills every language, English always with the city's own name", () => {
    const names = completeNames({ en: "Bergen Municipality", ru: "Берген" }, "Bergen");
    expect(Object.keys(names).toSorted()).toEqual(["ar", "de", "en", "es", "fr", "hi", "it", "ja", "pl", "pt", "ru", "tr", "uk", "zh-Hans", "zh-Hant"]);
    expect(names.en).toBe("Bergen");
    expect(names.ru).toBe("Берген");
    expect(names.ar).toBe("Bergen");
  });

  test("a city's names from Wikidata are complete", async () => {
    const names = await wikidataCityNames("Q649", "Moscow", answering(200, entity("Q649", { ja: "モスクワ" })).fetcher);
    expect(names._unsafeUnwrap()).toMatchObject({ en: "Moscow", ja: "モスクワ", de: "Moscow" });
  });
});
