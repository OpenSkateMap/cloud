import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { openDatabase, schema } from "@openskatemap/db";
import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { CurrentUser } from "../src/env.ts";
import { NewSpotDraftSchema } from "../src/lib/submission-schemas.ts";
import { approveSubmission } from "../src/services/review.ts";
import { saveSubmission } from "../src/services/submissions.ts";

const USAGE = "Usage: DATABASE_URL=... bun run import-spots <spots.json> --as <admin-user-id> [--dry-run]";
const NEARBY_METERS = 60;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { as: { type: "string" }, "dry-run": { type: "boolean", default: false } },
});

const Row = z.object({
  key: z.string().regex(/^[\w-]{1,64}$/),
  title: z.string(),
  description: z.string().optional(),
  kind: z.string(),
  obstacles: z.array(z.string()).default([]),
  latitude: z.number(),
  longitude: z.number(),
  note: z.string().optional(),
});
const Spot = Row.transform(({ key, kind, ...row }) => ({ key, draft: NewSpotDraftSchema.parse({ ...row, kind: "new_spot", spotKind: kind, photos: [] }) }));

const url = process.env.DATABASE_URL;
const [file] = positionals;
if (!url || !file || !values.as || positionals.length !== 1) {
  console.error(USAGE);
  process.exit(2);
}
const spots = z.array(Spot).parse(JSON.parse(await readFile(file, "utf8")));
if (new Set(spots.map((spot) => spot.key)).size !== spots.length) throw new Error("Every key must be unique");

// The same key always maps to the same submission, so a re-run approves nothing twice.
function submissionId(key: string) {
  const bytes = createHash("sha1").update(`openskatemap-import:${key}`).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const database = await openDatabase(url);
try {
  const { db } = database;
  const [account] = await db
    .select({ id: schema.user.id, name: schema.user.name, email: schema.user.email, role: schema.user.role, createdAt: schema.user.createdAt })
    .from(schema.user)
    .where(eq(schema.user.id, values.as));
  if (account?.role !== "admin") throw new Error(`${values.as} is not an admin`);
  const actor: CurrentUser = { ...account, role: "admin" };

  const counts = { imported: 0, alreadyImported: 0, nearExisting: 0, failed: 0 };
  for (const { key, draft } of spots) {
    const id = submissionId(key);
    const [previous] = await db.select({ spotId: schema.submission.spotId }).from(schema.submission).where(eq(schema.submission.id, id));
    const point = sql`ST_SetSRID(ST_MakePoint(${draft.longitude}, ${draft.latitude}), 4326)::geography`;
    const [near] = await db
      .select({ id: schema.spot.id, title: schema.spot.title })
      .from(schema.spot)
      .where(
        and(
          eq(schema.spot.status, "published"),
          eq(schema.spot.visibility, "public"),
          sql`ST_DWithin(${schema.spot.location}::geography, ${point}, ${NEARBY_METERS})`,
          previous?.spotId ? ne(schema.spot.id, previous.spotId) : undefined,
        ),
      )
      .limit(1);
    if (near) {
      counts.nearExisting += 1;
      console.warn(`skip ${key} "${draft.title}": within ${NEARBY_METERS} m of "${near.title}" (${near.id})`);
      continue;
    }
    if (values["dry-run"]) {
      console.log(`${previous ? "already" : "would import"} ${key}: ${draft.title} (${draft.spotKind})`);
      continue;
    }

    const saved = await saveSubmission(db, actor.id, id, draft);
    if (saved.isErr()) {
      counts.failed += 1;
      console.error(`fail ${key}: ${saved.error.message}`);
      continue;
    }
    if (saved.value.status === "approved") {
      counts.alreadyImported += 1;
      continue;
    }
    const approved = await approveSubmission(db, actor, id, { edits: {}, seenUpdatedAt: saved.value.updatedAt });
    if (approved.isErr()) {
      counts.failed += 1;
      console.error(`fail ${key}: ${approved.error.message}`);
      continue;
    }
    counts.imported += 1;
    console.log(`ok ${key}: ${draft.title} → ${approved.value.spotId}`);
  }
  console.log(JSON.stringify(counts));
  process.exitCode = counts.failed > 0 ? 1 : 0;
} finally {
  await database.close();
}
