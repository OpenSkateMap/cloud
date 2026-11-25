import { type Database, openDatabase } from "@openskatemap/db";
import { logFailure } from "./log.ts";

/** One connection for the job, closed before anything slower (pushes, R2) happens; undefined when it failed. */
export async function onDatabase<T>(env: Env, label: string, job: (db: Database) => Promise<T>): Promise<T | undefined> {
  const database = await openDatabase(env.HYPERDRIVE.connectionString);
  try {
    return await job(database.db);
  } catch (error) {
    logFailure(`${label} failed`, error);
    return undefined;
  } finally {
    await database.close();
  }
}
