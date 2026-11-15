import type { Database } from "@openskatemap/db";
import { spotScore } from "@openskatemap/db/schema";
import { desc, sql } from "drizzle-orm";
import type { SpotScores } from "../lib/spot-schemas.ts";

// shortcut: one response holds every public spot; make it a delta feed or per city once that grows large.
export async function spotScores(db: Database): Promise<SpotScores> {
  return { items: await db.select().from(spotScore).orderBy(desc(spotScore.score)) };
}

/** Concurrently, as the view's owner (migration 0024): readers keep the previous scores until the new ones are in. */
export async function refreshSpotScores(db: Database): Promise<void> {
  // Recomputing every spot outlasts the app role's request-sized timeouts. Postgres can turn a running transaction's
  // timeout off, but not extend it.
  await db.transaction(async (tx) => {
    await tx.execute(sql`set local transaction_timeout = 0`);
    await tx.execute(sql`set local statement_timeout = '2min'`);
    await tx.execute(sql`select refresh_spot_score()`);
  });
}
