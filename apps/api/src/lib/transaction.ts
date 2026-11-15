import type { Database } from "@openskatemap/db";
import { errorSummary } from "./log.ts";
import type { Result } from "./result";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Drizzle commits whatever the callback returns and rolls back only when it throws, so an `err` would keep the writes before it. */
export async function inTransaction<T, E>(db: Database, work: (tx: Transaction) => PromiseLike<Result<T, E>>): Promise<Result<T, E>> {
  const rollback = new Error("rollback");
  let failed: Result<T, E> | undefined;
  try {
    return await db.transaction(async (tx) => {
      const result = await work(tx);
      if (result.isErr()) {
        failed = result;
        throw rollback;
      }
      return result;
    });
  } catch (error) {
    if (error === rollback && failed) return failed;
    throw error;
  }
}

export const isUniqueViolation = (error: unknown) => errorSummary(error).code === "23505";
