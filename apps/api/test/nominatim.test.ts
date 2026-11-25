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

  const place = (answers: Record<string, unknown>) => async () => {
    const nominatim = fixtures(answers);
    const found = (await findCityPlace(kuta, nominatim.lookup))._unsafeUnwrap();
    return { name: found.name, zooms: nominatim.asked.map(({ url }) => new URL(url).searchParams.get("zoom")), pauses: nominatim.pauses.length };
  };
  const london = { address: { country_code: "gb", city: "Greater London" } };

  test("a borough whose city is wider asks zoom 6, then 5, for the place of that name", async () => {
    const camden = place({ "10": answer(51827, "city_district", "London Borough of Camden", london), "6": answer(175342, "city", "Greater London", london) });
    expect(await camden()).toEqual({ name: "Greater London", zooms: ["10", "6"], pauses: 1 });
    const mapo = place({
      "10": answer(3884279, "suburb", "Seogyo-dong", { address: { country_code: "kr", city: "Seoul" } }),
      "6": answer(2297418, "city", "Seoul", { address: { country_code: "kr", city: "Seoul" } }),
    });
    expect(await mapo()).toEqual({ name: "Seoul", zooms: ["10", "6"], pauses: 1 });
    const york = { address: { country_code: "us", city: "New York" } };
    const brooklyn = place({ "10": answer(9691750, "suburb", "Brooklyn", york), "6": answer(1, "state", "New York State", york), "5": answer(175905, "city", "New York", york) });
    expect(await brooklyn()).toEqual({ name: "New York", zooms: ["10", "6", "5"], pauses: 2 });
  });

  test("a suburb or village without a wider city gives way to zoom 8's district or regency", async () => {
    const kadikoy = place({
      "10": answer(9426227, "suburb", "Osmanağa Mahallesi", { address: { country_code: "tr" } }),
      "8": answer(1276548, "town", "Kadıköy", { address: { country_code: "tr" } }),
    });
    expect(await kadikoy()).toEqual({ name: "Kadıköy", zooms: ["10", "8"], pauses: 1 });
    const canggu = place({ "10": answer(17840125, "village", "Canggu"), "8": answer(14613953, "region", "Badung", { extratags: { wikidata: "Q11482" } }) });
    expect(await canggu()).toEqual({ name: "Badung", zooms: ["10", "8"], pauses: 1 });
  });

  test("a city that is its own address keeps zoom 10's answer, and so does a village whose zoom 8 is a province", async () => {
    const shibuya = place({ "10": answer(1759477, "city", "Shibuya", { address: { country_code: "jp", city: "Shibuya" } }) });
    expect(await shibuya()).toEqual({ name: "Shibuya", zooms: ["10"], pauses: 0 });
    const paris = place({ "10": answer(7444, "suburb", "Paris", { address: { country_code: "fr", city: "Paris" } }) });
    expect(await paris()).toEqual({ name: "Paris", zooms: ["10"], pauses: 0 });
    const village = place({ "10": answer(5, "village", "Hamlet-on-Sea", { address: { country_code: "jp" } }), "8": answer(6, "province", "Shizuoka Prefecture", { address: { country_code: "jp" } }) });
    expect(await village()).toEqual({ name: "Hamlet-on-Sea", zooms: ["10", "8"], pauses: 1 });
  });

  test("a wider city that never answers by its name falls back to the suburb rule", async () => {
    const lost = place({ "10": answer(51827, "city_district", "Camden", london), "6": answer(58447, "state", "England", london), "5": answer(58447, "state", "England", london), "8": answer(175342, "city", "Greater London", london) });
    expect(await lost()).toEqual({ name: "Greater London", zooms: ["10", "6", "5", "8"], pauses: 3 });
  });

  test("never a state, open sea or an answer without a country; a failed request is a failure, not a miss", async () => {
    const state = fixtures({ "10": answer(2, "state", "Bali") });
    expect((await findCityPlace(kuta, state.lookup))._unsafeUnwrapErr()).toEqual({ kind: "no_city", addressType: "state" });
    expect((await findCityPlace(kuta, fixtures({}).lookup))._unsafeUnwrapErr()).toEqual({ kind: "no_city", addressType: null });
    const stateless = fixtures({ "10": answer(3, "city", "Nowhere", { address: {} }) });
    expect((await findCityPlace(kuta, stateless.lookup))._unsafeUnwrapErr()).toEqual({ kind: "no_city", addressType: "city" });
    expect((await findCityPlace(kuta, fixtures({ "10": "fail" }).lookup))._unsafeUnwrapErr()).toEqual({ kind: "unreachable", service: "nominatim", status: 503 });
    const failingWider = fixtures({ "10": answer(1, "suburb", "Brooklyn", { address: { country_code: "us", city: "New York" } }), "6": "fail" });
    expect((await findCityPlace(kuta, failingWider.lookup))._unsafeUnwrapErr()).toEqual({ kind: "unreachable", service: "nominatim", status: 503 });
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
