import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { openDatabase } from "@openskatemap/db";
import { livePlaceLookup } from "../src/lib/nominatim.ts";
import { preloadCity, preloadedCity } from "../src/services/city-places.ts";
import { PRELOAD_LIST, PreloadListSchema } from "./preload-list.ts";

const USAGE = "Usage: DATABASE_URL=... bun run preload-cities [list.json, default data/preload-cities.json] [--dry-run]";

const { values, positionals } = parseArgs({ options: { "dry-run": { type: "boolean", default: false } }, allowPositionals: true });
const url = process.env.DATABASE_URL;
const entries = PreloadListSchema.safeParse(JSON.parse(await readFile(positionals[0] ?? PRELOAD_LIST, "utf8")));
if (!url || !entries.success) {
  console.error(USAGE);
  if (!entries.success) console.error(entries.error.issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`).join("\n"));
  process.exit(2);
}

const database = await openDatabase(url);
try {
  let creating = 0;
  // Smallest first: a city keeps its whole area, and a wider place that overlaps it takes only what's left.
  for (const entry of entries.data.toSorted((a, b) => a.areaKm2 - b.areaKm2)) {
    const place = `${entry.name} (${entry.country}, ${entry.wikidata}, relation/${entry.relation})`;
    if (values["dry-run"]) {
      const known = await preloadedCity(database.db, entry);
      if (!known) creating += 1;
      console.log(known ? `= ${place}: kept as ${known.slug}` : `+ ${place}: ${entry.areaKm2.toLocaleString("en")} km², hidden until its first spot`);
      continue;
    }
    const preloaded = await preloadCity(database.db, livePlaceLookup, entry);
    console.log(`${place}: ${preloaded.match((value) => `${value.kind} ${value.cityId}`, (failure) => `failed: ${JSON.stringify(failure)}`)}`);
  }
  if (values["dry-run"]) console.log(`${creating} of ${entries.data.length} would be created`);
} finally {
  await database.close();
}
