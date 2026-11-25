import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import { openDatabase, schema } from "@openskatemap/db";
import { asc, eq, inArray } from "drizzle-orm";
import { rgbaToThumbHash } from "thumbhash";
import { z } from "zod";
import type { CurrentUser } from "../src/env.ts";
import { PhotoCreditSchema } from "../src/lib/submission-schemas.ts";
import { saveClip } from "../src/services/clips.ts";
import { savePhoto, type UploadStore } from "../src/services/photos.ts";
import { approveSubmission } from "../src/services/review.ts";
import { saveSpotEdit } from "../src/services/spot-edits.ts";

const USAGE = "Usage: DATABASE_URL=... CLOUDFLARE_API_TOKEN=... bun run add-spot-photos <photos.json> --as <admin-user-id> [--dry-run]";
const BUCKET = "openskatemap-photos";
const WRANGLER = new URL("../../web/node_modules/.bin/wrangler", import.meta.url).pathname;
const CLIP_SECONDS = { min: 3, max: schema.CLIP_MAX_DURATION_MS / 1000 };
const CLIP_MAX_FPS = 30;
// A clip's id names how it was encoded, so a re-run after the encode changes replaces a clip encoded an earlier way in place.
const CLIP_ENCODING = ":aac";
const EARLIER_CLIP_ENCODINGS = [""];
const run = promisify(execFile);

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { as: { type: "string" }, "dry-run": { type: "boolean", default: false } },
});

// Rows of one spot keep their order; the first becomes the cover when the spot has no photos yet.
const Row = z.object({
  key: z.string().regex(/^[\w-]{1,64}$/),
  spotId: z.uuid(),
  file: z.string().min(1),
  credit: PhotoCreditSchema.default({ takenBy: "submitter" }),
  clip: z.string().min(1).optional(),
  clipStart: z.number().min(0).default(0),
});
type Row = z.infer<typeof Row>;

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

const Probe = z.object({ streams: z.tuple([z.object({ avg_frame_rate: z.string() })]), format: z.object({ duration: z.coerce.number() }) });

type ClipSource = { path: string; start: number };

/** How a clip is cut: from its start, at most 16 s and 30 fps, counted in frames so it never runs over. */
async function clipCut({ path, start }: ClipSource) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=avg_frame_rate:format=duration", "-of", "json", path]);
  const { streams, format } = Probe.parse(JSON.parse(stdout));
  const [numerator = 0, denominator = 0] = streams[0].avg_frame_rate.split("/").map(Number);
  const fps = denominator > 0 ? numerator / denominator : 0;
  const kept = fps > 0 && fps <= CLIP_MAX_FPS;
  const seconds = Math.min(CLIP_SECONDS.max, format.duration - start);
  const rate = kept ? fps : CLIP_MAX_FPS;
  const frames = Math.floor(seconds * rate);
  return { rate: kept ? streams[0].avg_frame_rate : String(CLIP_MAX_FPS), seconds, frames, length: frames / rate };
}

/** The first sound track's channels, at most two; 0 without sound. */
async function soundChannels(path: string) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels", "-of", "csv=p=0", path]);
  return Math.min(Number(stdout.trim()) || 0, 2);
}
type ClipCut = Awaited<ReturnType<typeof clipCut>>;

const scratch = await mkdtemp(join(tmpdir(), "spot-photos-"));

async function encodeClip({ path, start }: ClipSource, cut: ClipCut) {
  const output = join(scratch, `clip-${crypto.randomUUID()}.mp4`);
  // The shorter side at most 720 px, never scaled up, and both sides even.
  const scale = "scale=w='if(gt(iw,ih),-2,trunc(min(720,iw)/2)*2)':h='if(gt(iw,ih),trunc(min(720,ih)/2)*2,-2)'";
  const channels = await soundChannels(path);
  // The sound is trimmed to the picture's length, so it never runs the clip past 16 s.
  const sound = channels === 0 ? ["-an"] : ["-map", "0:a:0", "-c:a", "aac", "-b:a", `${64 * channels}k`, "-ac", String(channels), "-af", `atrim=end=${cut.length}`];
  await run("ffmpeg", [
    ...["-v", "error", "-y", "-ss", String(start), "-i", path, "-map", "0:v:0", "-frames:v", String(cut.frames)],
    ...["-vf", `fps=${cut.rate},${scale}`, "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-tag:v", "avc1"],
    ...["-b:v", "1800k", "-maxrate", "2000k", "-bufsize", "4000k", ...sound, "-map_metadata", "-1", "-movflags", "+faststart", output],
  ]);
  const bytes = new Uint8Array(await readFile(output));
  await rm(output);
  return bytes;
}

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

const store: UploadStore = {
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

/** A row's poster upload and its clip: `added` goes first, `replaces` takes the place of the row's earlier live photo (plain, or a clip encoded the earlier way), `live` is on the spot already. */
type Plan = {
  row: Row;
  photoId: string;
  clip?: { id: string; source: ClipSource; cut: ClipCut };
  place: { kind: "added" } | { kind: "replaces"; spotPhotoId: string } | { kind: "live" };
};

async function planRow(row: Row, liveUploads: Map<string, string>): Promise<Plan | string> {
  const plainId = uuidFrom(`openskatemap-photo:${row.key}`);
  const plainOnSpot = liveUploads.get(plainId);
  if (row.clip === undefined) return { row, photoId: plainId, place: plainOnSpot === undefined ? { kind: "added" } : { kind: "live" } };
  const source = { path: row.clip, start: row.clipStart };
  const sha = createHash("sha1").update(await readFile(row.clip)).digest("hex");
  const clipIdFor = (encoding: string) => uuidFrom(`openskatemap-clip:${row.key}:${sha}:${row.clipStart}${encoding}`);
  const photoIdFor = (clipId: string) => uuidFrom(`openskatemap-photo:${row.key}:clip:${clipId}`);
  const clipId = clipIdFor(CLIP_ENCODING);
  const photoId = photoIdFor(clipId);
  const cut = await clipCut(source);
  if (cut.seconds < CLIP_SECONDS.min) return `${row.key}: its clip would be ${Math.max(0, cut.seconds).toFixed(1)} s, under ${CLIP_SECONDS.min} s`;
  const earlier = [plainId, ...EARLIER_CLIP_ENCODINGS.map((encoding) => photoIdFor(clipIdFor(encoding)))];
  const replaced = earlier.map((id) => liveUploads.get(id)).find((id) => id !== undefined);
  const place: Plan["place"] = liveUploads.has(photoId)
    ? { kind: "live" }
    : replaced === undefined
      ? { kind: "added" }
      : { kind: "replaces", spotPhotoId: replaced };
  return { row, photoId, clip: { id: clipId, source, cut }, place };
}

const describePlan = ({ row, clip, place }: Plan) => {
  const clipped = clip === undefined ? "" : ` with a ${clip.cut.seconds.toFixed(1)} s clip from ${row.clipStart} s`;
  if (place.kind === "live") return `= ${row.key}${clipped}`;
  return `${place.kind === "replaces" ? "~" : "+"} ${row.key}${clipped}${place.kind === "replaces" ? ", replacing its live photo" : ""}`;
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

  const counts = { spots: 0, photos: 0, clips: 0, alreadyAdded: 0, failed: 0 };
  for (const [spotId, spotRows] of bySpot) {
    const [spot] = await db.select({ title: schema.spot.title, status: schema.spot.status }).from(schema.spot).where(eq(schema.spot.id, spotId));
    if (spot?.status !== "published") {
      counts.failed += 1;
      console.error(`fail ${spotId}: no published spot`);
      continue;
    }
    const live = await db
      .select({ id: schema.spotPhoto.id, r2Key: schema.spotPhoto.r2Key })
      .from(schema.spotPhoto)
      .where(eq(schema.spotPhoto.spotId, spotId))
      .orderBy(asc(schema.spotPhoto.position));
    const base = live.map((photo) => photo.id);
    // A spot photo copies its upload's R2 key, so that's how a live photo maps back to the upload it came from.
    const liveByKey = new Map(live.map((photo) => [photo.r2Key, photo.id]));
    const uploads =
      live.length === 0
        ? []
        : await db.select({ id: schema.photoUpload.id, r2Key: schema.photoUpload.r2Key }).from(schema.photoUpload).where(inArray(schema.photoUpload.r2Key, [...liveByKey.keys()]));
    const liveUploads = new Map(uploads.flatMap((upload) => { const spotPhotoId = liveByKey.get(upload.r2Key); return spotPhotoId === undefined ? [] : [[upload.id, spotPhotoId] as const]; }));

    const planned = [];
    for (const row of spotRows) planned.push(await planRow(row, liveUploads));
    const failures = planned.filter((plan) => typeof plan === "string");
    if (failures.length > 0) {
      counts.failed += 1;
      for (const failure of failures) console.error(`fail "${spot.title}": ${failure}`);
      continue;
    }
    const plans = planned.filter((plan) => typeof plan !== "string");
    const changes = plans.filter((plan) => plan.place.kind !== "live");
    if (values["dry-run"]) {
      console.log(`${changes.length === 0 ? "nothing for" : "would update"} "${spot.title}" (has ${base.length}): ${plans.map(describePlan).join(", ")}`);
      if (changes.length > 0) counts.spots += 1;
      counts.photos += changes.length;
      counts.clips += changes.filter((plan) => plan.clip !== undefined).length;
      continue;
    }
    if (changes.length === 0) {
      counts.alreadyAdded += plans.length;
      continue;
    }

    const photos = [];
    for (const { row, photoId, clip } of changes) {
      const saved = await savePhoto(db, store, actor.id, photoId, new Uint8Array(await readFile(row.file)));
      if (saved.isErr()) throw new Error(`${row.key}: ${saved.error.message}`);
      if (clip !== undefined) {
        // saveClip checks the encoded clip with cleanMp4 before anything is uploaded.
        const savedClip = await saveClip(db, store, actor.id, clip.id, await encodeClip(clip.source, clip.cut));
        if (savedClip.isErr()) throw new Error(`${row.key}: ${savedClip.error.message}`);
      }
      photos.push({ photoId, thumbhash: await thumbhashOf(row.file), credit: row.credit, ...(clip === undefined ? {} : { clipId: clip.id }) });
    }
    const replacing = new Map(changes.flatMap(({ photoId, place }) => (place.kind === "replaces" ? [[place.spotPhotoId, photoId] as const] : [])));
    const order = [...changes.filter((plan) => plan.place.kind === "added").map((plan) => plan.photoId), ...base.map((id) => replacing.get(id) ?? id)];
    const editId = uuidFrom(`openskatemap-photo-edit:${spotId}:${plans.map(({ row, clip }) => (clip === undefined ? row.key : `${row.key}:clip:${clip.id}`)).join(",")}`);
    const edit = await saveSpotEdit(db, actor.id, editId, { spotId, changes: {}, photos, photoEdit: { order, base }, note: "" });
    if (edit.isErr()) {
      counts.failed += 1;
      console.error(`fail "${spot.title}": ${edit.error.message}`);
      continue;
    }
    if (edit.value.status === "approved") {
      counts.alreadyAdded += plans.length;
      continue;
    }
    const approved = await approveSubmission(db, actor, editId, { edits: {}, seenUpdatedAt: edit.value.updatedAt, wholePhotoList: true });
    if (approved.isErr()) {
      counts.failed += 1;
      console.error(`fail "${spot.title}": ${approved.error.message}`);
      continue;
    }
    counts.spots += 1;
    counts.photos += changes.length;
    counts.clips += changes.filter((plan) => plan.clip !== undefined).length;
    console.log(`ok "${spot.title}": ${changes.map(describePlan).join(", ")}`);
  }
  console.log(JSON.stringify(counts));
  process.exitCode = counts.failed > 0 ? 1 : 0;
} finally {
  await database.close();
  await rm(scratch, { recursive: true, force: true });
}
