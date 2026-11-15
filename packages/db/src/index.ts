import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { toClientConfig } from "./connection.ts";
import * as schema from "./schema/index.ts";

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseSession {
  readonly db: Database;
  close(): Promise<void>;
}

export async function openDatabase(connectionString: string): Promise<DatabaseSession> {
  const client = new Client(toClientConfig(connectionString));
  let closing = false;
  // Unhandled, an idle connection's error crashes the isolate; after `end()`, pg-cloudflare reports our own close.
  client.on("error", (error) => {
    if (!closing) console.error("Database connection error", { name: error.name });
  });
  await client.connect();
  return {
    db: drizzle(client, { schema }),
    close: () => {
      closing = true;
      return client.end();
    },
  };
}

export { APP_ROLE_SETTINGS, TIMEOUT_CODES } from "./app-role.ts";
export { schema };
