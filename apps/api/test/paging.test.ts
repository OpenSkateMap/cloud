import { describe, expect, test } from "bun:test";
import { z } from "@hono/zod-openapi";
import { decodeCursor, encodeCursor, keysetPage, pageQuery } from "../src/lib/paging.ts";

const key = z.tuple([z.string(), z.number()]);

describe("paging", () => {
  test("a cursor is URL-safe and carries its sort key back exactly", () => {
    const sortKey: [string, number] = ["2026-01-01 00:00:03.123456+00", 42];
    const cursor = encodeCursor(sortKey);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor, key)).toEqual(sortKey);
    expect(decodeCursor(encodeCursor(["Plaça del Sol ✓", 1]), key)).toEqual(["Plaça del Sol ✓", 1]);
  });

  test("anything else isn't a cursor: garbage, or another list's key", () => {
    expect(decodeCursor("not a cursor!", key)).toBeUndefined();
    expect(decodeCursor(encodeCursor(["only one part"]), key)).toBeUndefined();
    expect(decodeCursor(encodeCursor([1, "swapped"]), key)).toBeUndefined();
  });

  test("the row past the limit only says there's another page, and the cursor names the last row shown", () => {
    const rows = [1, 2, 3].map((n) => ({ id: `s${n}`, n }));
    const more = keysetPage(rows, 2, (row) => [row.id, row.n]);
    expect(more.items).toEqual(rows.slice(0, 2));
    expect(decodeCursor(more.nextCursor!, z.tuple([z.string(), z.number()]))).toEqual(["s2", 2]);
    expect(keysetPage(rows, 3, (row) => [row.id, row.n]).nextCursor).toBeNull();
    expect(keysetPage([], 3, () => []).nextCursor).toBeNull();
  });

  test("the query decodes the cursor, so a bad one fails validation; the limit has a default and a ceiling", () => {
    const query = pageQuery({ key, defaultLimit: 200, maxLimit: 500 });
    expect(query.parse({})).toEqual({ limit: 200 });
    expect(query.parse({ cursor: encodeCursor(["a", 1]), limit: "5" })).toEqual({ cursor: ["a", 1], limit: 5 });
    expect(query.safeParse({ cursor: "garbage" }).success).toBe(false);
    expect(query.safeParse({ limit: "501" }).success).toBe(false);
  });
});
