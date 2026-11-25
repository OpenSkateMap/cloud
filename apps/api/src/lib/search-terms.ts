export interface SearchTerm {
  readonly word: string;
  /** Wrong letters the word may have and still match a title's word: none under 5 letters, one up to 7, two from 8. */
  readonly typos: 0 | 1 | 2;
}

export function allowedTypos(word: string): SearchTerm["typos"] {
  const letters = [...word].length;
  return letters >= 8 ? 2 : letters >= 5 ? 1 : 0;
}

/** `folded` is what `search_fold()` made of the query: words separated by single spaces. */
export const searchTerms = (folded: string): SearchTerm[] =>
  [...new Set(folded.split(" ").filter((word) => word !== ""))].map((word) => ({ word, typos: allowedTypos(word) }));

/**
 * pg_trgm's `word_similarity_threshold` for finding typo candidates; undefined when no term allows typos. It sits under
 * the lowest similarity a match can have: a word of n letters has n + 1 trigrams, each wrong letter changes up to three,
 * and a word still being typed misses its last. A hundredth lower again, as pg_trgm computes in single precision.
 */
export function typoThreshold(terms: readonly SearchTerm[]): string | undefined {
  const floors = terms
    .filter(({ typos }) => typos > 0)
    .map(({ word, typos }) => {
      const letters = [...word].length;
      return (letters - 3 * typos) / (letters + 1 + 3 * typos);
    });
  return floors.length === 0 ? undefined : ((Math.floor(Math.min(...floors) * 100) - 1) / 100).toFixed(2);
}
