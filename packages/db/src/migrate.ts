import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { configureAppRole } from "./app-role.ts";
import { toClientConfig } from "./connection.ts";

const MIN_POSTGIS = [3, 6] as const;

function isAtLeast(version: string, minimum: readonly number[]): boolean {
  const parts = version.split(".").map(Number);
  for (let i = 0; i < minimum.length; i++) {
    const diff = (parts[i] ?? 0) - (minimum[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return true;
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required (use the migration role, never the app role)");
  process.exit(2);
}

const client = new Client(toClientConfig(url));
await client.connect();
try {
  // DDL waiting for a lock queues every query on that table behind it; failing (and rolling back) beats stalling the API.
  await client.query("set lock_timeout = '3s'");
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: new URL("../migrations", import.meta.url).pathname });

  const result = await db.execute<{ extversion: string }>(
    sql`select extversion from pg_extension where extname = 'postgis'`,
  );
  const version = result.rows[0]?.extversion;
  if (!version) throw new Error("PostGIS is not installed after migrating");
  if (!isAtLeast(version, MIN_POSTGIS)) throw new Error(`PostGIS ${version} is older than ${MIN_POSTGIS.join(".")}`);
  console.log(`migrations applied; PostGIS ${version}`);
} finally {
  await client.end();
}

const appUrl = process.env.DATABASE_URL_APP;
if (appUrl) {
  const app = new Client(toClientConfig(appUrl));
  await app.connect();
  try {
    console.log(`app role settings: ${(await configureAppRole(app)).join(", ")}`);
  } finally {
    await app.end();
  }
} else {
  console.log("app role settings skipped: set DATABASE_URL_APP (the Worker's role) to apply them");
}
