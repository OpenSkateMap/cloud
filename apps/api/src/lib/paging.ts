import { z } from "@hono/zod-openapi";
import { type AnyColumn, type SQL, sql } from "drizzle-orm";
import { queryNumber } from "./query.ts";

// Keyset paging: a page is the rows after the last one seen, in a fixed order, read through an index on the sort key.
// The cursor is that last row's sort key, opaque to clients; no OFFSET, no COUNT.

type KeyPart = string | number;

export function encodeCursor(key: readonly KeyPart[]): string {
  return new TextEncoder().encode(JSON.stringify(key)).toBase64({ alphabet: "base64url", omitPadding: true });
}

export function decodeCursor<T extends z.ZodType<readonly KeyPart[]>>(cursor: string, key: T): z.output<T> | undefined {
  try {
    const parsed = key.safeParse(JSON.parse(new TextDecoder().decode(Uint8Array.fromBase64(cursor, { alphabet: "base64url" }))));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** A paged list's query: `cursor` (decoded here, so a malformed one is a 422) and `limit`. */
export function pageQuery<T extends z.ZodType<readonly KeyPart[]>>({ key, defaultLimit, maxLimit }: { key: T; defaultLimit: number; maxLimit: number }) {
  return z.object({
    cursor: z
      .string()
      .max(512)
      .transform((value, context) => {
        const decoded = decodeCursor(value, key);
        if (decoded === undefined) context.addIssue({ code: "custom", message: "Not a cursor this list gave out" });
        return decoded ?? z.NEVER;
      })
      .optional()
      .openapi({ type: "string", description: "`nextCursor` from the previous page, as it came (opaque); leave it out for the first page" }),
    limit: queryNumber({ min: 1, max: maxLimit, integer: true }).default(defaultLimit),
  });
}

export function pageOf<T extends z.ZodType>(item: T, name: string) {
  return z
    .object({
      items: z.array(item),
      nextCursor: z.string().nullable().openapi({ description: "Send it as `cursor` for the next page; null on the last page" }),
    })
    .openapi(name);
}

/**
 * SQL: rows after the cursor's sort key in `order`, as one row comparison (every column sorts the same way), which a
 * composite index on the columns answers. Key parts are bound as they are: Postgres types them from the columns.
 */
export function after(columns: readonly AnyColumn[], key: readonly KeyPart[], order: "asc" | "desc" = "asc"): SQL {
  if (columns.length !== key.length) throw new Error("A cursor's key has one part per sort column");
  const row = sql.join([...columns], sql`, `);
  const values = sql.join(key.map((part) => sql`${part}`), sql`, `);
  return order === "asc" ? sql`(${row}) > (${values})` : sql`(${row}) < (${values})`;
}

/** `rows` fetched with `limit + 1`: the extra one only says another page exists. */
export function keysetPage<Row>(rows: readonly Row[], limit: number, keyOf: (row: Row) => readonly KeyPart[]): { items: Row[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > limit && last !== undefined ? encodeCursor(keyOf(last)) : null };
}
