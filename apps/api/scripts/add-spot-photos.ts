import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import { openDatabase, schema } from "@openskatemap/db";
import { asc, eq } from "drizzle-orm";
import { rgbaToThumbHash } from "thumbhash";
import { z } from "zod";
import type { CurrentUser } from "../src/env.ts";
import { PhotoCreditSchema } from "../src/lib/submission-schemas.ts";
import { type PhotoStore, savePhoto } from "../src/services/photos.ts";
import { approveSubmission } from "../src/services/review.ts";
import { saveSpotEdit } from "../src/services/spot-edits.ts";

const USAGE = "Usage: DATABASE_URL=... CLOUDFLARE_API_TOKEN=... bun run add-spot-photos <photos.json> --as <admin-user-id> [--dry-run]";
const BUCKET = "openskatemap-photos";
const WRANGLER = new URL("../../web/node_modules/.bin/wrangler", import.meta.url).pathname;
const run = promisify(execFile);

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { as: { type: "string" }, "dry-run": { type: "boolean", default: false } },
});

// Rows of one spot keep their order; the first becomes the cover when the spot has no photos yet.
const Row = z.object({ key: z.string().regex(/^[\w-]{1,64}$/), spotId: z.uuid(), file: z.string().min(1), credit: PhotoCreditSchema.default({ takenBy: "submitter" }) });

const url = process.env.DATABASE_URL;
const [file] = positionals;
if (!url || !file || !values.as || positionals.length !== 1) {
  console.error(USAGE);
  process.exit(2);
}
const rows = z.array(Row).parse(JSON.parse(await readFile(file, "utf8")));
if (new Set(rows.map((row) => row.key)).size !== rows.length) throw new Error("Every key must be unique");

// The same key always maps to the same upload and the same spot's rows to the same edit, so a re-run adds nothing twice.
function uuidFrom(text: string) {
  const bytes = createHash("sha1").update(text).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function thumbhashOf(path: string) {
  const { stdout: size } = await run("magick", [path, "-auto-orient", "-resize", "100x100", "-format", "%wx%h", "info:"]);
  const [width = 0, height = 0] = size.trim().split("x").map(Number);
  const { stdout: rgba } = await run("magick", [path, "-auto-orient", "-resize", "100x100", "-depth", "8", "rgba:-"], { encoding: "buffer", maxBuffer: 1 << 20 });
  return Buffer.from(rgbaToThumbHash(width, height, rgba)).toString("base64");
}

const scratch = await mkdtemp(join(tmpdir(), "spot-photos-"));
async function wrangler(args: string[], attempts = 3) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run(WRANGLER, args);
    } catch (error) {
      if (attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
}

const store: PhotoStore = {
  async put(key, value, options) {
    const path = join(scratch, key.replaceAll("/", "_"));
    await writeFile(path, value);
    const { contentType, cacheControl } = options.httpMetadata;
    await wrangler(["r2", "object", "put", `${BUCKET}/${key}`, "--file", path, "--content-type", contentType, "--cache-control", cacheControl, "--remote"]);
    await rm(path);
  },
  async delete(key) {
    await wrangler(["r2", "object", "delete", `${BUCKET}/${key}`, "--remote"]);
  },
};

const bySpot = Map.groupBy(rows, (row) => row.spotId);
const database = await openDatabase(url);
try {
  const { db } = database;
  const [account] = await db
    .select({ id: schema.user.id, name: schema.user.name, email: schema.user.email, role: schema.user.role, createdAt: schema.user.createdAt })
    .from(schema.user)
    .where(eq(schema.user.id, values.as));
  if (account?.role !== "admin") throw new Error(`${values.as} is not an admin`);
  const actor: CurrentUser = { ...account, role: "admin" };

  const counts = { spots: 0, photos: 0, alreadyAdded: 0, failed: 0 };
  for (const [spotId, spotRows] of bySpot) {
    const [spot] = await db.select({ title: schema.spot.title, status: schema.spot.status }).from(schema.spot).where(eq(schema.spot.id, spotId));
    if (spot?.status !== "published") {
      counts.failed += 1;
      console.error(`fail ${spotId}: no published spot`);
      continue;
    }
    const base = (await db.select({ id: schema.spotPhoto.id }).from(schema.spotPhoto).where(eq(schema.spotPhoto.spotId, spotId)).orderBy(asc(schema.spotPhoto.position))).map((photo) => photo.id);
    const editId = uuidFrom(`openskatemap-photo-edit:${spotId}:${spotRows.map((row) => row.key).join(",")}`);
    if (values["dry-run"]) {
      console.log(`would add ${spotRows.length} to "${spot.title}" (has ${base.length}): ${spotRows.map((row) => row.key).join(", ")}`);
      counts.spots += 1;
      counts.photos += spotRows.length;
      continue;
    }

    const photos = [];
    for (const row of spotRows) {
      const photoId = uuidFrom(`openskatemap-photo:${row.key}`);
      const saved = await savePhoto(db, store, actor.id, photoId, new Uint8Array(await readFile(row.file)));
      if (saved.isErr()) throw new Error(`${row.key}: ${saved.error.message}`);
      photos.push({ photoId, thumbhash: await thumbhashOf(row.file), credit: row.credit });
    }
    const order = [...photos.map((photo) => photo.photoId), ...base];
    const edit = await saveSpotEdit(db, actor.id, editId, { spotId, changes: {}, photos, photoEdit: { order, base }, note: "" });
    if (edit.isErr()) {
      counts.failed += 1;
      console.error(`fail "${spot.title}": ${edit.error.message}`);
      continue;
    }
    if (edit.value.status === "approved") {
      counts.alreadyAdded += spotRows.length;
      continue;
    }
    const approved = await approveSubmission(db, actor, editId, { edits: {}, seenUpdatedAt: edit.value.updatedAt, wholePhotoList: true });
    if (approved.isErr()) {
      counts.failed += 1;
      console.error(`fail "${spot.title}": ${approved.error.message}`);
      continue;
    }
    counts.spots += 1;
    counts.photos += spotRows.length;
    console.log(`ok "${spot.title}": +${spotRows.length}`);
  }
  console.log(JSON.stringify(counts));
  process.exitCode = counts.failed > 0 ? 1 : 0;
} finally {
  await database.close();
  await rm(scratch, { recursive: true, force: true });
}
