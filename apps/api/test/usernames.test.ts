import { describe, expect, test } from "bun:test";
import { isAllowedUsername } from "../src/lib/usernames.ts";

describe("isAllowedUsername", () => {
  test("swearing is refused however it's spelled", () => {
    for (const name of ["shithead", "Sh1tHead", "f_u_c_k_it", "big_ass_skater"]) expect([name, isAllowedUsername(name)]).toEqual([name, false]);
  });

  test("our own names and companies' names are refused, also inside a longer name", () => {
    for (const name of ["OpenSkateMap_HQ", "NikeSB_official", "n1ke_rider", "g00gle", "admin_ertem", "Support", "palace_skate", "vans2026"]) {
      expect([name, isAllowedUsername(name)]).toEqual([name, false]);
    }
  });

  test("everyday names that only contain one of those words are fine", () => {
    for (const name of ["ertem", "Ertem_Biyik", "badminton", "metalhead", "pineapple_kid", "evans_sk8", "classic_sk8", "assassin_x", "hancock_skates", "cockatoo"]) {
      expect([name, isAllowedUsername(name)]).toEqual([name, true]);
    }
  });
});
