import type { Client } from "pg";

/**
 * The Worker's session defaults, set on its own role: Hyperdrive pools in transaction mode and resets each connection
 * it takes back, so a `SET` never outlives its transaction, while a role's defaults start every pooled session.
 * Values follow PlanetScale's connection-resilience guidance, with room for a small instance's cold reads.
 */
export const APP_ROLE_SETTINGS = {
  statement_timeout: "5s",
  lock_timeout: "2s",
  idle_in_transaction_session_timeout: "5s",
  transaction_timeout: "10s",
} as const satisfies Record<string, `${number}${"ms" | "s" | "min"}`>;

/** Postgres's codes for work stopped by one of those timeouts: statement, lock wait, idle in a transaction, transaction. */
export const TIMEOUT_CODES: ReadonlySet<string> = new Set(["57014", "55P03", "25P03", "25P04"]);

// A role may change its own defaults; the migration role can't change the app role's on PlanetScale.
export async function configureAppRole(client: Client): Promise<string[]> {
  for (const [name, value] of Object.entries(APP_ROLE_SETTINGS)) {
    await client.query(`alter role current_user set ${name} = '${value}'`);
  }
  const result = await client.query<{ setting: string }>(
    "select unnest(setconfig) as setting from pg_db_role_setting where setrole = (select oid from pg_roles where rolname = current_user) and setdatabase = 0",
  );
  return result.rows.map((row) => row.setting);
}
