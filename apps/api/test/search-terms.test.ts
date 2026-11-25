import { describe, expect, test } from "bun:test";
import { allowedTypos, searchTerms, typoThreshold } from "../src/lib/search-terms.ts";

describe("search terms", () => {
  test("words of 5 letters or more allow one wrong letter, from 8 two", () => {
    expect(["bort", "plaza", "ledges", "krestov", "naberezh", "novokrestovskaya"].map(allowedTypos)).toEqual([0, 1, 1, 1, 2, 2]);
  });

  test("the folded query's words, each once", () => {
    expect(searchTerms("novo novo krest")).toEqual([
      { word: "novo", typos: 0 },
      { word: "krest", typos: 1 },
    ]);
    expect(searchTerms("")).toEqual([]);
  });

  test("typo candidates sit under the weakest match the shortest typo-tolerant word allows", () => {
    expect(typoThreshold(searchTerms("bort"))).toBeUndefined();
    // Five letters, one wrong, still typing: 2 of 9 trigrams.
    expect(typoThreshold(searchTerms("plaza"))).toBe("0.21");
    // Eight letters, two wrong: 2 of 15.
    expect(typoThreshold(searchTerms("naberezh novokrestovskaya"))).toBe("0.12");
    expect(typoThreshold(searchTerms("novokrestovskaya"))).toBe("0.42");
  });
});
