import { parseArgs } from "node:util";
import { openDatabase } from "@openskatemap/db";
import { z } from "zod";
import { WikidataIdSchema, wikidataCityNames } from "../src/lib/wikidata.ts";
import { boxArea, saveCity } from "../src/services/cities.ts";

const USAGE =
  "Usage: DATABASE_URL=... bun run create-city --slug <slug> --name <English name> --country <ISO 3166-1 alpha-2> --bbox=west,south,east,north [--wikidata <QID>]";

const { values } = parseArgs({
  options: {
    slug: { type: "string" },
    name: { type: "string" },
    country: { type: "string" },
    bbox: { type: "string" },
    wikidata: { type: "string" },
  },
});

const longitude = z.number().min(-180).max(180);
const latitude = z.number().min(-90).max(90);
const Input = z.object({
  url: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9-]{2,40}$/),
  name: z.string().trim().min(1),
  country: z.string().regex(/^[A-Z]{2}$/),
  bbox: z
    .string()
    .transform((text) => text.split(",").map(Number))
    .pipe(z.tuple([longitude, latitude, longitude, latitude]))
    .refine(([west, south, east, north]) => west < east && south < north, "west < east and south < north"),
  wikidata: WikidataIdSchema.optional(),
});
const parsed = Input.safeParse({ url: process.env.DATABASE_URL, ...values });
if (!parsed.success) {
  console.error(USAGE);
  console.error(parsed.error.issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`).join("\n"));
  process.exit(2);
}
const { url, slug, name, country, bbox, wikidata } = parsed.data;

let names;
if (wikidata !== undefined) {
  const found = await wikidataCityNames(wikidata, name);
  if (found.isErr()) {
    console.error(`${wikidata}: Wikidata ${found.error.kind}${"status" in found.error ? ` (${found.error.status})` : ""}; nothing saved`);
    process.exit(1);
  }
  names = { byLanguage: found.value, wikidataId: wikidata };
  console.log(Object.entries(found.value).map(([language, text]) => `  ${language}: ${text}`).join("\n"));
}

const database = await openDatabase(url);
try {
  const moved = await saveCity(database.db, { slug, name, countryCode: country, area: boxArea(bbox), names });
  console.log(`${slug}: saved; ${moved} spot(s) changed city`);
} finally {
  await database.close();
}
