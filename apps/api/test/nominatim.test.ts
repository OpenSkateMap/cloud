import { describe, expect, test } from "bun:test";
import { findCityPlace, type PlaceLookup, placeNames, relationPlace } from "../src/lib/nominatim.ts";
import { LOOKUP_USER_AGENT } from "../src/lib/wikidata.ts";

const square = [[[115.1, -8.8], [115.2, -8.8], [115.2, -8.7], [115.1, -8.7], [115.1, -8.8]]];

const answer = (osmId: number, addresstype: string, name: string, extra: Record<string, unknown> = {}) => ({
  osm_type: "relation",
  osm_id: osmId,
  addresstype,
  name,
  boundingbox: ["-8.8", "-8.7", "115.1", "115.2"],
  address: { country_code: "id" },
  extratags: {},
  namedetails: { name },
  geojson: { type: "Polygon", coordinates: square },
  ...extra,
});

/** Answers Nominatim by zoom (or `lookup`), Wikidata by item; records what was asked and every pause. */
function fixtures(byZoom: Record<string, unknown>, labels: Record<string, Record<string, string>> = {}) {
  const asked: { url: string; userAgent: string | null }[] = [];
  const pauses: number[] = [];
  const lookup: PlaceLookup = {
    nominatim: async (input, init) => {
      asked.push({ url: input, userAgent: new Headers(init?.headers).get("User-Agent") });
      const url = new URL(input);
      const key = url.pathname === "/lookup" ? "lookup" : (url.searchParams.get("zoom") ?? "");
      const body = byZoom[key];
      return body === "fail" ? new Response("", { status: 503 }) : Response.json(body ?? { error: "Unable to geocode" });
    },
    wikidata: async (input) => {
      const id = input.split("/").at(-1)!.replace(".json", "");
      return Response.json({ entities: { [id]: { labels: Object.fromEntries(Object.entries(labels[id] ?? {}).map(([language, value]) => [language, { value }])) } } });
    },
    spacingMs: 1000,
    pause: async (milliseconds) => void pauses.push(milliseconds),
  };
  return { asked, pauses, lookup };
}

const kuta = { latitude: -8.72, longitude: 115.17 };

describe("findCityPlace", () => {
  test("a city at zoom 10 is the place, asked once as a named client with its boundary, extra tags and names in English", async () => {
    const nominatim = fixtures({ "10": answer(3437391, "city", "Kazan", { address: { country_code: "ru" }, extratags: { wikidata: "Q900" } }) });
    const place = (await findCityPlace({ latitude: 55.79, longitude: 49.12 }, nominatim.lookup))._unsafeUnwrap();
    expect(place).toMatchObject({ id: "relation/3437391", name: "Kazan", countryCode: "RU", addressType: "city", wikidataId: "Q900" });
    expect(place.area).toEqual({ kind: "boundary", geometry: { type: "Polygon", coordinates: square } });
    expect(nominatim.asked).toHaveLength(1);
    const url = new URL(nominatim.asked[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe("https://nominatim.openstreetmap.org/reverse");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      format: "jsonv2",
      lat: "55.79",
      lon: "49.12",
      zoom: "10",
      polygon_geojson: "1",
      polygon_threshold: "0.001",
      extratags: "1",
      namedetails: "1",
      "accept-language": "en",
    });
    expect(nominatim.asked[0]!.userAgent).toBe(LOOKUP_USER_AGENT);
  });

  test("Kuta is a suburb at zoom 10, so zoom 8's regency, Badung, is the place, a second later", async () => {
    const nominatim = fixtures({ "10": answer(7760993, "suburb", "Kuta"), "8": answer(14613953, "region", "Badung", { extratags: { wikidata: "Q11482" } }) });
    const place = (await findCityPlace(kuta, nominatim.lookup))._unsafeUnwrap();
    expect(place).toMatchObject({ id: "relation/14613953", name: "Badung", addressType: "region", wikidataId: "Q11482" });
    expect(nominatim.asked.map(({ url }) => new URL(url).searchParams.get("zoom"))).toEqual(["10", "8"]);
    expect(nominatim.pauses).toEqual([1000]);
  });

  test("never a state, open sea or an answer without a country; a failed request is a failure, not a miss", async () => {
    const state = fixtures({ "10": answer(1, "village", "Somewhere"), "8": answer(2, "state", "Bali") });
    expect((await findCityPlace(kuta, state.lookup))._unsafeUnwrapErr()).toEqual({ kind: "no_city", addressType: "state" });
    expect((await findCityPlace(kuta, fixtures({}).lookup))._unsafeUnwrapErr()).toEqual({ kind: "no_city", addressType: null });
    const stateless = fixtures({ "10": answer(3, "city", "Nowhere", { address: {} }) });
    expect((await findCityPlace(kuta, stateless.lookup))._unsafeUnwrapErr()).toEqual({ kind: "no_city", addressType: "city" });
    expect((await findCityPlace(kuta, fixtures({ "10": "fail" }).lookup))._unsafeUnwrapErr()).toEqual({ kind: "unreachable", service: "nominatim", status: 503 });
  });

  test("a place mapped without a boundary keeps its box", async () => {
    const node = fixtures({ "10": answer(4, "town", "Pointville", { osm_type: "node", geojson: { type: "Point", coordinates: [115.15, -8.75] } }) });
    expect((await findCityPlace(kuta, node.lookup))._unsafeUnwrap()).toMatchObject({ id: "node/4", area: { kind: "box", bbox: [115.1, -8.8, 115.2, -8.7] } });
  });
});

describe("relationPlace", () => {
  test("asks for the relation by id with its boundary", async () => {
    const nominatim = fixtures({ lookup: [answer(1543125, "city", "Tokyo", { address: { country_code: "jp" } })] });
    expect((await relationPlace(1543125, nominatim.lookup))._unsafeUnwrap()).toMatchObject({ id: "relation/1543125", name: "Tokyo", countryCode: "JP" });
    expect(new URL(nominatim.asked[0]!.url).searchParams.get("osm_ids")).toBe("R1543125");
  });
});

describe("placeNames", () => {
  test("the place's own OpenStreetMap names come first, then Wikidata's labels, then its English name", async () => {
    const nominatim = fixtures({ "10": answer(404159, "municipality", "Bergen", { address: { country_code: "no" }, extratags: { wikidata: "Q10428388" }, namedetails: { name: "Bergen", "name:ja": "ベルゲン", "name:zh": "卑爾根" } }) });
    const place = (await findCityPlace({ latitude: 60.39, longitude: 5.32 }, nominatim.lookup))._unsafeUnwrap();
    const labels = { Q10428388: { en: "Bergen Municipality", ja: "ベルゲン自治体", ru: "Берген", "zh-hans": "卑尔根" } };
    const names = (await placeNames(place, fixtures({}, labels).lookup))._unsafeUnwrap();
    expect(names).toMatchObject({ en: "Bergen", ja: "ベルゲン", ru: "Берген", "zh-Hans": "卑尔根", "zh-Hant": "Bergen", de: "Bergen" });
  });
});
