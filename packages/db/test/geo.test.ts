import { expect, test } from "bun:test";
import { parsePoint } from "../src/schema/geo.ts";

const southbank = { latitude: 51.5065, longitude: -0.1167 };

test("reads the hex EWKB Postgres returns for a geometry with an SRID", () => {
  expect(parsePoint("0101000020E61000008E75711B0DE0BDBF46B6F3FDD4C04940")).toEqual(southbank);
});

test("reads plain WKB too", () => {
  expect(parsePoint("01010000008e75711b0de0bdbf46b6f3fdd4c04940")).toEqual(southbank);
});

test("refuses anything that is not a point", () => {
  expect(() => parsePoint("010200000000000000")).toThrow("Not a 2D point");
});
