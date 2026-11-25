import { z } from "zod";
import { WikidataIdSchema } from "../src/lib/wikidata.ts";

/** A row of `data/preload-cities.json`, which `build-preload-list` writes and `preload-cities` reads. */
export const PreloadListEntrySchema = z.object({
  wikidata: WikidataIdSchema,
  relation: z.int().positive(),
  name: z.string().min(1),
  country: z.string().regex(/^[A-Z]{2}$/),
  population: z.int().nonnegative(),
  areaKm2: z.number().nonnegative(),
});
export const PreloadListSchema = z.array(PreloadListEntrySchema);
export type PreloadListEntry = z.infer<typeof PreloadListEntrySchema>;

export const PRELOAD_LIST = new URL("../data/preload-cities.json", import.meta.url).pathname;
