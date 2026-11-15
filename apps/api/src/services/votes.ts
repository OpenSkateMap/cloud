import type { Database } from "@openskatemap/db";
import { spot, spotVote } from "@openskatemap/db/schema";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { AppError } from "../lib/errors.ts";
import { err, ok, type Result } from "../lib/result.ts";
import type { SpotVotes } from "../lib/spot-schemas.ts";

export const noVotes: SpotVotes = { up: 0, down: 0, mine: 0 };

export async function voteTotals(db: Database, viewerId: string, spotIds: readonly string[]): Promise<Map<string, SpotVotes>> {
  if (spotIds.length === 0) return new Map();
  const rows = await db
    .select({
      spotId: spotVote.spotId,
      up: sql<number>`(count(*) filter (where ${spotVote.value} = 1))::int`,
      down: sql<number>`(count(*) filter (where ${spotVote.value} = -1))::int`,
      mine: sql<number>`coalesce(max(${spotVote.value}) filter (where ${spotVote.userId} = ${viewerId}), 0)::int`,
    })
    .from(spotVote)
    .where(inArray(spotVote.spotId, [...spotIds]))
    .groupBy(spotVote.spotId);
  return new Map(rows.map(({ spotId, ...votes }) => [spotId, votes]));
}

/** `changedAt` is when the vote this request replaced or removed was set; undefined when nothing changed. */
export async function voteOnSpot(
  db: Database,
  userId: string,
  spotId: string,
  value: number,
): Promise<Result<{ votes: SpotVotes; changedAt: Date | undefined }, AppError>> {
  if ((await db.$count(spot, and(eq(spot.id, spotId), eq(spot.status, "published"), eq(spot.visibility, "public")))) === 0) {
    return err({ code: "not_found", message: "No such spot" });
  }
  const mine = and(eq(spotVote.spotId, spotId), eq(spotVote.userId, userId));
  const [changed] =
    value === 0
      ? await db.delete(spotVote).where(mine).returning({ updatedAt: spotVote.updatedAt })
      : await db
          .insert(spotVote)
          .values({ spotId, userId, value })
          .onConflictDoUpdate({ target: [spotVote.spotId, spotVote.userId], set: { value, updatedAt: new Date() }, setWhere: ne(spotVote.value, value) })
          .returning({ updatedAt: spotVote.updatedAt });
  return ok({ votes: (await voteTotals(db, userId, [spotId])).get(spotId) ?? noVotes, changedAt: changed?.updatedAt });
}
