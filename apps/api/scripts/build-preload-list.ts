import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { openDatabase } from "@openskatemap/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { livePlaceLookup, type RelationPlace, relationPlaces } from "../src/lib/nominatim.ts";
import { LOOKUP_USER_AGENT } from "../src/lib/wikidata.ts";
import { type PreloadListEntry, PreloadListSchema } from "./preload-list.ts";

const USAGE = "Usage: DATABASE_URL=<any PostGIS, e.g. the local one> bun run build-preload-list";

// Relations chosen by hand where the item's own tag gives the wrong boundary or none; they skip the size limit.
const OVERRIDES: Record<string, number> = {
  Q1490: 19631009, // Tokyo: the 23 special wards, not the prefecture with the Ogasawara Islands
  Q406: 223474, // Istanbul: no relation carries its item
  Q84: 175342, // London: Greater London, not the ceremonial county
};
const MAX_AREA_KM2 = 10_000;
// Wikidata labels some items as the administration ("Monterrey Municipality"); OpenStreetMap's English name rarely does.
const ADMINISTRATIVE_NAME = /\b(Municipality|Municipal|County|Regency|Prefecture|Province|Urban Okrug|City of)\b/;
const NESTED_SHARE = 0.9;
const BATCH = 50;

const data = (name: string) => new URL(`../data/${name}`, import.meta.url).pathname;
const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const headers = { "User-Agent": LOOKUP_USER_AGENT, Accept: "application/json" };

const url = process.env.DATABASE_URL;
if (!url) {
  console.error(USAGE);
  process.exit(2);
}

const value = z.object({ value: z.string() });
const SparqlSchema = z.object({
  results: z.object({ bindings: z.array(z.object({ item: value, population: value, country: value.optional(), name: value.optional() })) }),
});
interface Candidate {
  readonly item: string;
  readonly population: number;
  readonly country: string | undefined;
  readonly name: string | undefined;
}

// The query service allows a minute of query time a minute and answers 429 past it; its answer is kept for a rerun.
const sparqlCache = `${tmpdir()}/openskatemap-preload-sparql.json`;
const SparqlCacheSchema = z.record(z.string(), z.unknown());

async function sparql(query: string): Promise<Candidate[]> {
  const cache = SparqlCacheSchema.parse(JSON.parse(await readFile(sparqlCache, "utf8").catch(() => "{}")));
  let answer = cache[query];
  for (let attempt = 1; answer === undefined; attempt += 1) {
    const response = await fetch(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(query)}`, { headers });
    if (response.ok) {
      answer = await response.json();
      await writeFile(sparqlCache, JSON.stringify({ ...cache, [query]: answer }));
      break;
    }
    await response.body?.cancel();
    if (attempt === 4 || (response.status !== 429 && response.status < 500)) throw new Error(`Wikidata's query service answered ${response.status}`);
    const waitSeconds = Number(response.headers.get("retry-after")) || attempt * 30;
    console.log(`  Wikidata's query service answered ${response.status}; asking again in ${waitSeconds} s`);
    await pause(waitSeconds * 1000);
  }
  return SparqlSchema.parse(answer).results.bindings.map((row) => ({
    item: row.item.value.split("/").at(-1) ?? row.item.value,
    population: Number(row.population.value),
    country: row.country?.value,
    name: row.name?.value,
  }));
}

const OverpassSchema = z.object({ elements: z.array(z.object({ id: z.int(), tags: z.record(z.string(), z.string()).default({}) })) });

// What Overpass answered for each item is kept for a rerun, so an outage halfway costs only the items after it.
const overpassCache = `${tmpdir()}/openskatemap-preload-overpass.json`;
const OverpassCacheSchema = z.record(z.string(), z.array(z.int()));

async function overpass(items: string[]): Promise<Map<string, number[]> | undefined> {
  // A union of exact tags uses Overpass's tag index; a regex over the tag scans every relation.
  const query = `[out:json][timeout:180];(${items.map((item) => `rel[boundary=administrative][wikidata="${item}"];`).join("")});out tags;`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ data: query }),
    });
    if (response.ok) {
      const tagged = new Map(items.map((item): [string, number[]] => [item, []]));
      for (const { id, tags } of OverpassSchema.parse(await response.json()).elements) {
        const item = tags.wikidata;
        if (item && tagged.has(item)) tagged.get(item)!.push(id);
      }
      await pause(2000);
      return tagged;
    }
    await response.body?.cancel();
    console.log(`  Overpass answered ${response.status}`);
    if (attempt < 3) await pause(attempt * 20_000);
  }
  return undefined;
}

// A batch Overpass keeps failing (its gateway gives up on a slow query) is asked again in halves.
async function relationsOf(items: string[]): Promise<Map<string, number[]>> {
  const answer = await overpass(items);
  if (answer) return answer;
  if (items.length <= 5) throw new Error(`Overpass keeps failing for ${items.join(", ")}`);
  const half = Math.ceil(items.length / 2);
  return new Map([...(await relationsOf(items.slice(0, half))), ...(await relationsOf(items.slice(half)))]);
}

/** Every administrative relation that carries one of the items as its own `wikidata` tag. */
async function relationsTagged(items: string[]): Promise<Map<string, number[]>> {
  const known = OverpassCacheSchema.parse(JSON.parse(await readFile(overpassCache, "utf8").catch(() => "{}")));
  const asking = items.filter((item) => !(item in known));
  for (let start = 0; start < asking.length; start += BATCH) {
    for (const [item, relations] of await relationsOf(asking.slice(start, start + BATCH))) known[item] = relations;
    await writeFile(overpassCache, JSON.stringify(known));
    console.log(`  Overpass: ${Math.min(start + BATCH, asking.length)} of ${asking.length} items`);
  }
  return new Map(items.flatMap((item): [string, number[]][] => (known[item]?.length ? [[item, known[item]]] : [])));
}

async function boundaries(relations: number[]): Promise<Map<number, RelationPlace>> {
  const found = new Map<number, RelationPlace>();
  for (let start = 0; start < relations.length; start += BATCH) {
    if (start > 0) await pause(livePlaceLookup.spacingMs);
    const batch = await relationPlaces(relations.slice(start, start + BATCH), livePlaceLookup);
    if (batch.isErr()) throw new Error(`Nominatim: ${JSON.stringify(batch.error)}`);
    for (const place of batch.value) found.set(place.relation, place);
  }
  return found;
}

const candidates = await sparql(await readFile(data("preload-cities.rq"), "utf8"));
const missing = Object.keys(OVERRIDES).filter((item) => !candidates.some((row) => row.item === item));
if (missing.length > 0) {
  const values = missing.map((item) => `wd:${item}`).join(" ");
  candidates.push(
    ...(await sparql(`SELECT ?item (MAX(?p) AS ?population) (SAMPLE(?cc) AS ?country) (SAMPLE(?label) AS ?name) WHERE {
      VALUES ?item { ${values} } ?item wdt:P1082 ?p . OPTIONAL { ?item wdt:P17/wdt:P297 ?cc }
      OPTIONAL { ?item rdfs:label ?label . FILTER(LANG(?label) = "en") } } GROUP BY ?item`)),
  );
}
candidates.sort((a, b) => a.item.localeCompare(b.item));
console.log(`${candidates.length} candidates from Wikidata`);

const tagged = await relationsTagged(candidates.map((row) => row.item));
for (const [item, relation] of Object.entries(OVERRIDES)) tagged.set(item, [relation]);
const relations = [...new Set([...tagged.values()].flat())].sort((a, b) => a - b);
console.log(`${relations.length} relations carry their items`);
const places = await boundaries(relations);

type Skipped = { wikidata: string; name: string; country: string | null; population: number; reason: string; relation?: number; areaKm2?: number };
const skipped: Skipped[] = [];
const label = (row: Candidate) => ({ wikidata: row.item, name: row.name ?? row.item, country: row.country ?? null, population: Math.round(row.population) });

const database = await openDatabase(url);
let measured: Map<number, number>;
let nested: { inner: number; outer: number }[];
try {
  const { db } = database;
  await db.execute(sql`create temporary table preload_relation (relation bigint primary key, geom geometry(MultiPolygon, 4326) not null)`);
  for (const { relation, place } of places.values()) {
    const area =
      place.area.kind === "boundary"
        ? sql`ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(place.area.geometry)}), 4326)), 3))`
        : sql`ST_Multi(ST_MakeEnvelope(${place.area.bbox[0]}, ${place.area.bbox[1]}, ${place.area.bbox[2]}, ${place.area.bbox[3]}, 4326))`;
    await db.execute(sql`insert into preload_relation values (${relation}, ${area})`);
  }
  const areas = await db.execute<{ relation: string; km2: number }>(sql`select relation, ST_Area(geom::geography) / 1e6 as km2 from preload_relation`);
  measured = new Map(areas.rows.map((row) => [Number(row.relation), Number(row.km2)]));
  const chosenByHand = Object.values(OVERRIDES);
  await db.execute(sql`delete from preload_relation where ST_Area(geom::geography) / 1e6 > ${MAX_AREA_KM2} and relation not in (${sql.join(chosenByHand.map((relation) => sql`${relation}`), sql`, `)})`);
  const pairs = await db.execute<{ inner: string; outer: string }>(sql`
    select a.relation as inner, b.relation as outer from preload_relation a join preload_relation b on a.relation <> b.relation and a.geom && b.geom
    where ST_Area(ST_Intersection(a.geom, b.geom)::geography) >= ${NESTED_SHARE} * ST_Area(a.geom::geography)
  `);
  nested = pairs.rows.map((row) => ({ inner: Number(row.inner), outer: Number(row.outer) }));
} finally {
  await database.close();
}

const chosen = new Map<number, PreloadListEntry & { linkedCity: boolean }>();
for (const row of candidates) {
  const options = (tagged.get(row.item) ?? []).flatMap((relation) => {
    const place = places.get(relation);
    return place ? [{ relation, place, areaKm2: measured.get(relation) ?? 0 }] : [];
  });
  if (options.length === 0) {
    skipped.push({ ...label(row), reason: (tagged.get(row.item) ?? []).length === 0 ? "no relation carries the item" : "Nominatim doesn't know its relation" });
    continue;
  }
  const small = options.filter((option) => option.areaKm2 <= MAX_AREA_KM2 || OVERRIDES[row.item] === option.relation);
  if (small.length === 0) {
    const [largest] = options.toSorted((a, b) => b.areaKm2 - a.areaKm2);
    skipped.push({ ...label(row), reason: `over ${MAX_AREA_KM2.toLocaleString("en")} km²`, relation: largest!.relation, areaKm2: Math.round(largest!.areaKm2) });
    continue;
  }
  const [best] = small.toSorted((a, b) => Number(b.place.linkedPlace === "city") - Number(a.place.linkedPlace === "city") || b.areaKm2 - a.areaKm2);
  const entry = {
    ...label(row),
    // The country Nominatim gives the place, which is what preloading stores.
    country: best!.place.place.countryCode,
    name: row.name && !(ADMINISTRATIVE_NAME.test(row.name) && !ADMINISTRATIVE_NAME.test(best!.place.place.name)) ? row.name : best!.place.place.name,
    relation: best!.relation,
    areaKm2: Math.round(best!.areaKm2 * 10) / 10,
    linkedCity: best!.place.linkedPlace === "city",
  };
  const holder = chosen.get(entry.relation);
  if (holder && holder.population >= entry.population) skipped.push({ ...label(row), reason: `same relation as ${holder.name}`, relation: entry.relation });
  else {
    if (holder) skipped.push({ ...holder, reason: `same relation as ${entry.name}` });
    chosen.set(entry.relation, entry);
  }
}

// A place at least 90 % inside another gives way to it, unless only it is a city proper (Los Angeles in its county).
for (const { inner, outer } of nested.toSorted((a, b) => (measured.get(b.outer) ?? 0) - (measured.get(a.outer) ?? 0) || a.inner - b.inner)) {
  const a = chosen.get(inner);
  const b = chosen.get(outer);
  if (!a || !b) continue;
  const [loser, winner] = a.linkedCity && !b.linkedCity ? [b, a] : [a, b];
  chosen.delete(loser.relation);
  skipped.push({ ...loser, reason: `${Math.round(NESTED_SHARE * 100)} % or more of it is shared with ${winner.name}` });
}

const list = PreloadListSchema.parse(
  [...chosen.values()].map(({ linkedCity: _, ...entry }) => entry).toSorted((a, b) => b.population - a.population || a.wikidata.localeCompare(b.wikidata)),
);
const lines = (rows: unknown[]) => `[\n${rows.map((row) => `  ${JSON.stringify(row)}`).join(",\n")}\n]\n`;
await writeFile(data("preload-cities.json"), lines(list));
await writeFile(data("preload-cities-skipped.json"), lines(skipped.toSorted((a, b) => b.population - a.population)));

const geometryBytes = list.reduce((total, entry) => {
  const area = places.get(entry.relation)?.place.area;
  return total + (area ? JSON.stringify(area.kind === "boundary" ? area.geometry : area.bbox).length : 0);
}, 0);
console.log(`${list.length} cities, ${(geometryBytes / 1e6).toFixed(1)} MB of boundaries at 0.001°; ${skipped.length} skipped`);
for (const entry of list.slice(0, 20)) console.log(`  ${entry.name} (${entry.country}) ${entry.population.toLocaleString("en")} people, ${entry.areaKm2.toLocaleString("en")} km², relation/${entry.relation}`);
