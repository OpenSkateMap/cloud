import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Database, openDatabase, schema } from "@openskatemap/db";
import { inArray, sql } from "drizzle-orm";
import { CityBoundariesSchema } from "../src/lib/spot-schemas.ts";
import { call, e2eUrl } from "./support.ts";

const { city, osmPlace } = schema;

type Ring = readonly (readonly [number, number])[];

const signedArea = (ring: Ring) => ring.slice(1).reduce((sum, [x, y], index) => sum + ring[index]![0] * y - x * ring[index]![1], 0) / 2;

describe.skipIf(!e2eUrl)("city boundaries (database)", () => {
  const database = e2eUrl ? openDatabase(e2eUrl) : undefined;
  const tag = crypto.randomUUID().slice(0, 8);
  const relation = () => `relation/${900_000_000 + Math.floor(Math.random() * 90_000_000)}`;
  const preloaded = { id: `e2e-bounds-preloaded-${tag}`, place: relation(), wikidataId: `Q${900_000_000 + Math.floor(Math.random() * 90_000_000)}` };
  const handDrawnId = `e2e-bounds-hand-${tag}`;
  const strayPlace = relation();
  // ST_MakeEnvelope draws its ring clockwise; GeoJSON wants outer rings counterclockwise.
  const box = (west: number, south: number) => sql`ST_Multi(ST_MakeEnvelope(${west}, ${south}, ${west + 0.1}, ${south + 0.1}, 4326))`;
  let db: Database;

  beforeAll(async () => {
    db = (await database!).db;
    const place = { names: {}, countryCode: "aq", addressType: "city", area: box(-120, -70) };
    await db.insert(osmPlace).values([
      { ...place, id: preloaded.place, name: `Preloaded ${tag}`, slug: `preloaded-${tag}`, wikidataId: preloaded.wikidataId },
      { ...place, id: strayPlace, name: `Stray ${tag}`, slug: `stray-${tag}`, area: box(-110, -70) },
    ]);
    await db.insert(city).values([
      {
        id: preloaded.id,
        slug: `e2e-bounds-preloaded-${tag}`,
        name: `Preloaded ${tag}`,
        names: { de: `Vorgeladen ${tag}` },
        wikidataId: preloaded.wikidataId,
        osmPlaceId: preloaded.place,
        countryCode: "AQ",
        area: box(-120, -70),
      },
      { id: handDrawnId, slug: `e2e-bounds-hand-${tag}`, name: `Hand ${tag}`, countryCode: "AQ", area: box(-100, -70) },
    ]);
  });

  afterAll(async () => {
    await db.delete(city).where(inArray(city.id, [preloaded.id, handDrawnId]));
    await db.delete(osmPlace).where(inArray(osmPlace.id, [preloaded.place, strayPlace]));
    await (await database!).close();
  });

  test("anyone downloads every city's boundary as GeoJSON under the ODbL, cacheable for a day", async () => {
    const { status, headers, body } = await call("/v1/cities/boundaries");
    expect(status).toBe(200);
    expect(headers.get("content-type")).toBe("application/geo+json");
    expect(headers.get("cache-control")).toBe("public, max-age=86400");
    expect(headers.get("access-control-allow-origin")).toBe("*");
    expect(CityBoundariesSchema.parse(body)).toMatchObject({
      type: "FeatureCollection",
      license: "ODbL-1.0",
      licenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
      attribution: "© OpenStreetMap contributors",
      attributionUrl: "https://www.openstreetmap.org/copyright",
    });
  });

  test("a city made ahead of its first spot is there with its source; a hand-drawn one too; rings run counterclockwise", async () => {
    const { features } = CityBoundariesSchema.parse((await call("/v1/cities/boundaries")).body);
    const feature = (id: string) => features.find((candidate) => candidate.properties.id === id);
    expect(feature(preloaded.id)?.properties).toEqual({
      id: preloaded.id,
      slug: `e2e-bounds-preloaded-${tag}`,
      name: `Preloaded ${tag}`,
      names: { de: `Vorgeladen ${tag}` },
      countryCode: "AQ",
      wikidataId: preloaded.wikidataId,
      source: "openstreetmap",
    });
    const handDrawn = feature(handDrawnId);
    expect(handDrawn?.properties).toMatchObject({ wikidataId: null, source: "hand-drawn" });
    const outer = handDrawn!.geometry.coordinates[0]![0]!;
    expect(new Set(outer.map(([longitude, latitude]) => `${longitude},${latitude}`))).toEqual(new Set(["-100,-70", "-99.9,-70", "-99.9,-69.9", "-100,-69.9"]));
    expect(signedArea(outer)).toBeGreaterThan(0);
  });

  test("a stored OpenStreetMap place without a city stays out", async () => {
    const { features } = CityBoundariesSchema.parse((await call("/v1/cities/boundaries")).body);
    expect(JSON.stringify(features)).not.toContain(`Stray ${tag}`);
    expect(features.filter(({ geometry }) => JSON.stringify(geometry).includes("[-110,-70]"))).toEqual([]);
  });
});
