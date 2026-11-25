import { CITY_LANGUAGES, type CityLanguage, type CityNames } from "@openskatemap/db/schema";
import { z } from "zod";
import type { Fetch } from "../auth/apple-tokens.ts";
import { err, ok, type Result } from "./result.ts";

// Wikimedia's and OpenStreetMap's usage policies ask automated clients to say who they are.
export const LOOKUP_USER_AGENT = "OpenSkateMap/1.0 (+https://openskatemap.app)";

export const WikidataIdSchema = z.string().regex(/^Q[1-9][0-9]*$/);

export type LookupFailure =
  | { readonly kind: "unreachable"; readonly service: string; readonly status?: number }
  | { readonly kind: "unreadable"; readonly service: string };

const EntityDataSchema = z.object({
  entities: z.record(z.string(), z.object({ labels: z.record(z.string(), z.object({ value: z.string() })).default({}) })),
});

/** The item's labels in the apps' languages (Wikidata's `zh-hans`, `zh-hant`), leaving out languages it has none in. */
export async function wikidataLabels(id: string, fetcher: Fetch = fetch): Promise<Result<CityNames, LookupFailure>> {
  const service = "wikidata";
  let response: Response;
  try {
    response = await fetcher(`https://www.wikidata.org/wiki/Special:EntityData/${id}.json`, {
      headers: { "User-Agent": LOOKUP_USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return err({ kind: "unreachable", service });
  }
  if (!response.ok) {
    await response.body?.cancel();
    return err({ kind: "unreachable", service, status: response.status });
  }
  const parsed = EntityDataSchema.safeParse(await response.json().catch(() => undefined));
  // A merged item answers under the id it was merged into.
  const entity = parsed.success ? (parsed.data.entities[id] ?? Object.values(parsed.data.entities)[0]) : undefined;
  if (!entity) return err({ kind: "unreadable", service });
  const labels: CityNames = {};
  for (const language of CITY_LANGUAGES) {
    const label = entity.labels[language.toLowerCase()]?.value.trim();
    if (label) labels[language] = label;
  }
  return ok(labels);
}

/** Every language filled: English is always `name`, the rest from `found` or else `name`. */
export function completeNames(found: CityNames, name: string): Record<CityLanguage, string> {
  const names = { en: name } as Record<CityLanguage, string>;
  for (const language of CITY_LANGUAGES) names[language] ??= found[language] ?? name;
  return names;
}

/** A city's names in the apps' languages from its Wikidata item, for `saveCity()`. */
export async function wikidataCityNames(id: string, name: string, fetcher: Fetch = fetch): Promise<Result<Record<CityLanguage, string>, LookupFailure>> {
  return (await wikidataLabels(id, fetcher)).map((labels) => completeNames(labels, name));
}
