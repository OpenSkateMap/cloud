import type { Database } from "@openskatemap/db";
import { city, spot, spotPhoto } from "@openskatemap/db/schema";
import { and, asc, eq, or, type SQL, sql } from "drizzle-orm";
import { type SearchTerm, searchTerms, typoThreshold } from "../lib/search-terms.ts";
import type { SpotIndexRow } from "../lib/spot-schemas.ts";
import { coverJoin, indexColumns, toIndexRow } from "./spots.ts";

export interface SpotSearch {
  readonly query: string;
  readonly limit: number;
  readonly near?: { readonly latitude: number; readonly longitude: number } | undefined;
}

// search_fold() leaves only letters, digits and spaces, so a word needs no LIKE escaping.
const startsWord = (word: string) => sql`(' ' || ${spot.searchText}) like ${`% ${word}%`}`;
const contains = (word: string) => sql`${spot.searchText} like ${`%${word}%`}`;
const cityWords = sql`search_words(${city.name} || ' ' || coalesce((select string_agg(value, ' ') from jsonb_each_text(${city.names})), ''))`;
const inCity = (word: string) => sql`${spot.cityId} = any(array(select ${city.id} from ${city} where (' ' || ${cityWords}) like ${`% ${word}%`}))`;

/** A word of the title within the allowed typos of the term, as typed so far (`left`) or whole. */
const nearlyMatches = ({ word, typos }: SearchTerm) =>
  typos === 0
    ? undefined
    : sql`(${word} <% ${spot.searchText} and exists (
        select from unnest(string_to_array(${spot.searchText}, ' ')) as title(word)
        where least(levenshtein_less_equal(${word}, title.word, ${typos}), levenshtein_less_equal(${word}, left(title.word, char_length(${word})), ${typos})) <= ${typos}
      ))`;

/** 1: every word starts a word of the title or of its city's name in any language; 2: every word is in the title; 3: some word only with typos. */
const tier = (terms: readonly SearchTerm[]) =>
  sql`greatest(${sql.join(
    terms.map(({ word }) => sql`case when ${startsWord(word)} or ${inCity(word)} then 1 when ${contains(word)} then 2 else 3 end`),
    sql`, `,
  )})`;

// Every match gets a distance; on 22k rows a geography cast took 20 times as long as this sphere distance.
const distanceTo = ({ latitude, longitude }: NonNullable<SpotSearch["near"]>) =>
  sql`ST_DistanceSphere(${spot.location}, ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326))`;

export async function searchSpots(db: Database, { query, limit, near }: SpotSearch): Promise<SpotIndexRow[]> {
  return db.transaction(async (tx) => {
    const folded = await tx.execute<{ folded: string }>(sql`select search_fold(${query}) as folded`);
    const terms = searchTerms(folded.rows[0]?.folded ?? "");
    if (terms.length === 0) return [];
    const threshold = typoThreshold(terms);
    // Local to the transaction: Hyperdrive hands the session to other requests after it.
    if (threshold !== undefined) await tx.execute(sql`select set_config('pg_trgm.word_similarity_threshold', ${threshold}, true)`);
    const order: SQL[] = [tier(terms), ...(near ? [distanceTo(near)] : []), asc(spot.title), asc(spot.id)];
    const rows = await tx
      .select(indexColumns)
      .from(spot)
      .leftJoin(spotPhoto, coverJoin)
      .where(
        and(
          eq(spot.status, "published"),
          eq(spot.visibility, "public"),
          ...terms.map((term) => or(contains(term.word), inCity(term.word), nearlyMatches(term))),
        ),
      )
      .orderBy(...order)
      .limit(limit);
    return rows.map(toIndexRow);
  });
}
