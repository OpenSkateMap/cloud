import { readFile } from "node:fs/promises";
import { openDatabase } from "@openskatemap/db";
import { z } from "zod";
import { livePlaceLookup } from "../src/lib/nominatim.ts";
import { WikidataIdSchema } from "../src/lib/wikidata.ts";
import { preloadCity } from "../src/services/city-places.ts";

const USAGE = "Usage: DATABASE_URL=... bun run preload-cities <entries.json>, a list of { wikidata: QID, relation: OpenStreetMap relation id }";

const EntriesSchema = z.array(z.object({ wikidata: WikidataIdSchema, relation: z.int().positive() }));
const [path] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
const entries = path ? EntriesSchema.safeParse(JSON.parse(await readFile(path, "utf8"))) : undefined;
if (!url || !entries?.success) {
  console.error(USAGE);
  if (entries && !entries.success) console.error(entries.error.issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`).join("\n"));
  process.exit(2);
}

const database = await openDatabase(url);
try {
  for (const entry of entries.data) {
    const preloaded = await preloadCity(database.db, livePlaceLookup, entry);
    const outcome = preloaded.match(
      (value) => `${value.kind} ${value.cityId}`,
      (failure) => `failed: ${JSON.stringify(failure)}`,
    );
    console.log(`${entry.wikidata} relation/${entry.relation}: ${outcome}`);
  }
} finally {
  await database.close();
}
