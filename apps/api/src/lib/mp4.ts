import { CLIP_MAX_DURATION_MS } from "@openskatemap/db/schema";
import { err, ok, type Result, safeTry } from "./result.ts";

export interface CleanMp4 {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly durationMs: number;
}

const MAX_SIDE = 1920;

const KEPT_IN_MOVIE = new Set(["mvhd", "trak"]);
const KEPT_IN_TRACK = new Set(["tkhd", "edts", "mdia", "tref"]);

interface Box {
  readonly type: string;
  readonly start: number;
  readonly body: number;
  readonly end: number;
}

interface Track {
  readonly trak: Box;
  readonly kept: Box[];
  readonly tkhd: Box;
  readonly mdhd: Box;
  readonly chunkOffsets: Box;
}

type File = { readonly bytes: Uint8Array; readonly data: DataView };

const fourcc = (bytes: Uint8Array, at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
const sizeOf = (box: Box) => box.end - box.start;

function boxesIn({ bytes, data }: File, from: number, to: number): Result<Box[], string> {
  const boxes: Box[] = [];
  for (let at = from; at < to; ) {
    if (to - at < 8) return err("malformed MP4 box");
    const short = data.getUint32(at);
    // 0 means "runs to the end of the file", 1 a 64-bit size after the type.
    if (short === 0) return err("malformed MP4 box");
    const header = short === 1 ? 16 : 8;
    if (to - at < header) return err("malformed MP4 box");
    const size = short === 1 ? Number(data.getBigUint64(at + 8)) : short;
    if (size < header || size > to - at) return err("malformed MP4 box");
    boxes.push({ type: fourcc(bytes, at + 4), start: at, body: at + header, end: at + size });
    at += size;
  }
  return ok(boxes);
}

function single(boxes: Box[], type: string): Result<Box, string> {
  const found = boxes.filter((box) => box.type === type);
  return found.length === 1 && found[0] ? ok(found[0]) : err(`the clip needs exactly one ${type} box`);
}

/** Creation and modification times sit right after a full box's version and flags: 32-bit in version 0, 64-bit in 1. */
const timesLength = (file: File, box: Box) => (file.bytes[box.body] === 1 ? 16 : 8);

function movieDuration(file: File, mvhd: Box): Result<number, string> {
  const wide = file.bytes[mvhd.body] === 1;
  const timescaleAt = mvhd.body + 4 + timesLength(file, mvhd);
  if (timescaleAt + (wide ? 12 : 8) > mvhd.end) return err("malformed movie header");
  const timescale = file.data.getUint32(timescaleAt);
  const duration = wide ? Number(file.data.getBigUint64(timescaleAt + 4)) : file.data.getUint32(timescaleAt + 4);
  const durationMs = timescale === 0 ? 0 : Math.round((duration * 1000) / timescale);
  if (durationMs === 0) return err("the clip has no duration");
  if (durationMs > CLIP_MAX_DURATION_MS) return err(`the clip is longer than ${CLIP_MAX_DURATION_MS / 1000} s`);
  return ok(durationMs);
}

function videoSize(file: File, tkhd: Box): Result<{ width: number; height: number }, string> {
  const matrixAt = tkhd.body + (file.bytes[tkhd.body] === 1 ? 52 : 40);
  const sizeAt = matrixAt + 36;
  if (sizeAt + 8 > tkhd.end) return err("malformed track header");
  const [a, b, c, d] = [0, 4, 12, 16].map((offset) => file.data.getInt32(matrixAt + offset));
  // 16.16 fixed point, as stored: the matrix may turn it a quarter.
  const stored = { width: Math.round(file.data.getUint32(sizeAt) / 65536), height: Math.round(file.data.getUint32(sizeAt + 4) / 65536) };
  const { width, height } = a === 0 && d === 0 && b !== 0 && c !== 0 ? { width: stored.height, height: stored.width } : stored;
  if (width === 0 || height === 0) return err("no video size in the track header");
  if (width > MAX_SIDE || height > MAX_SIDE) return err(`the video is too large (${width}×${height}); send at most ${MAX_SIDE} px per side`);
  return ok({ width, height });
}

// A data reference that isn't self-contained points players at another file or URL.
function selfContained(file: File, minf: Box[]): Result<void, string> {
  return safeTry(function* () {
    for (const dinf of minf.filter((box) => box.type === "dinf")) {
      for (const dref of (yield* boxesIn(file, dinf.body, dinf.end)).filter((box) => box.type === "dref")) {
        for (const entry of yield* boxesIn(file, dref.body + 8, dref.end)) {
          if (entry.body + 4 > entry.end || ((file.bytes[entry.body + 3] ?? 0) & 1) === 0) return err("the clip's media refers to another file");
        }
      }
    }
    return ok(undefined);
  });
}

function videoTrack(file: File, trak: Box): Result<Track, string> {
  return safeTry(function* () {
    const parts = yield* boxesIn(file, trak.body, trak.end);
    const tkhd = yield* single(parts, "tkhd");
    const mdia = yield* single(parts, "mdia");
    const media = yield* boxesIn(file, mdia.body, mdia.end);
    const hdlr = yield* single(media, "hdlr");
    const handler = hdlr.body + 12 <= hdlr.end ? fourcc(file.bytes, hdlr.body + 8) : "";
    if (handler === "soun") return err("the clip has sound; send the clip without sound");
    // Timed metadata (`meta`, `mebx`) can carry locations; dropping its track would leave its samples in mdat.
    if (handler !== "vide") return err("the clip has a track that isn't video; send video only");
    const mdhd = yield* single(media, "mdhd");
    if (mdhd.body + 4 + timesLength(file, mdhd) > mdhd.end) return err("malformed media header");
    const minf = yield* single(media, "minf");
    const info = yield* boxesIn(file, minf.body, minf.end);
    yield* selfContained(file, info);
    const stbl = yield* single(info, "stbl");
    const table = yield* boxesIn(file, stbl.body, stbl.end);
    const stsd = yield* single(table, "stsd");
    const codec = stsd.body + 16 <= stsd.end ? fourcc(file.bytes, stsd.body + 12) : "";
    if (codec !== "avc1" && codec !== "avc3") return err("the video isn't H.264");
    const offsets = table.filter((box) => box.type === "stco" || box.type === "co64");
    if (offsets.length !== 1 || !offsets[0]) return err("the clip needs exactly one chunk offset table");
    return ok({ trak, kept: parts.filter((box) => KEPT_IN_TRACK.has(box.type)), tkhd, mdhd, chunkOffsets: offsets[0] });
  });
}

/** Every chunk offset, shifted by `shift`, written into `moov` (a copy of the movie box that starts at `moovStart`). */
function shiftChunks(file: File, moov: Uint8Array, moovStart: number, table: Box, mdat: Box, shift: number): Result<void, string> {
  const wide = table.type === "co64";
  const width = wide ? 8 : 4;
  if (table.body + 8 > table.end) return err("malformed chunk offset table");
  const count = file.data.getUint32(table.body + 4);
  if (count === 0) return err("the clip has no frames");
  if (table.body + 8 + count * width > table.end) return err("malformed chunk offset table");
  const out = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  for (let index = 0; index < count; index += 1) {
    const at = table.body + 8 + index * width;
    const offset = wide ? Number(file.data.getBigUint64(at)) : file.data.getUint32(at);
    if (offset < mdat.body || offset >= mdat.end) return err("a chunk of the clip lies outside its media data");
    const shifted = offset + shift;
    if (wide) out.setBigUint64(at - moovStart, BigInt(shifted));
    else if (shifted > 0xffff_ffff) return err("the clip is too large to rewrite");
    else out.setUint32(at - moovStart, shifted);
  }
  return ok(undefined);
}

/** Rebuilds the clip as ftyp, the movie box with only what plays its one silent H.264 track, and the media data; recording times are zeroed. */
export function cleanMp4(input: Uint8Array): Result<CleanMp4, string> {
  if (input.length < 8 || fourcc(input, 4) !== "ftyp") return err("not an MP4");
  const file: File = { bytes: input, data: new DataView(input.buffer, input.byteOffset, input.byteLength) };
  return safeTry(function* () {
    const top = yield* boxesIn(file, 0, input.length);
    if (top.some((box) => box.type === "moof")) return err("the clip is fragmented; send one progressive MP4");
    const ftyp = top[0];
    if (!ftyp) return err("not an MP4");
    const moov = yield* single(top, "moov");
    const mdat = yield* single(top, "mdat");
    if (moov.start > mdat.start) return err("the clip's index comes after its media; encode it with faststart (-movflags +faststart)");

    const movie = yield* boxesIn(file, moov.body, moov.end);
    if (movie.some((box) => box.type === "mvex")) return err("the clip is fragmented; send one progressive MP4");
    const mvhd = yield* single(movie, "mvhd");
    const durationMs = yield* movieDuration(file, mvhd);
    const tracks: Track[] = [];
    for (const trak of movie.filter((box) => box.type === "trak")) tracks.push(yield* videoTrack(file, trak));
    const [track] = tracks;
    if (!track) return err("the clip has no video track");
    if (tracks.length > 1) return err("the clip has more than one video track");
    const { width, height } = yield* videoSize(file, track.tkhd);

    const kept = movie.filter((box) => KEPT_IN_MOVIE.has(box.type));
    const trakSize = 8 + track.kept.reduce((total, box) => total + sizeOf(box), 0);
    const moovSize = 8 + kept.reduce((total, box) => total + (box.type === "trak" ? trakSize : sizeOf(box)), 0);
    const shift = sizeOf(ftyp) + moovSize - mdat.start;

    const patched = input.slice(moov.start, moov.end);
    for (const box of [mvhd, track.tkhd, track.mdhd]) patched.fill(0, box.body + 4 - moov.start, box.body + 4 + timesLength(file, box) - moov.start);
    yield* shiftChunks(file, patched, moov.start, track.chunkOffsets, mdat, shift);

    const bytes = new Uint8Array(sizeOf(ftyp) + moovSize + sizeOf(mdat));
    const out = new DataView(bytes.buffer);
    let at = 0;
    const header = (size: number, type: string) => {
      out.setUint32(at, size);
      bytes.set([...type].map((character) => character.charCodeAt(0)), at + 4);
      at += 8;
    };
    const copy = (part: Uint8Array) => {
      bytes.set(part, at);
      at += part.length;
    };
    copy(input.subarray(ftyp.start, ftyp.end));
    header(moovSize, "moov");
    for (const box of kept) {
      if (box.type !== "trak") {
        copy(patched.subarray(box.start - moov.start, box.end - moov.start));
        continue;
      }
      header(trakSize, "trak");
      for (const part of track.kept) copy(patched.subarray(part.start - moov.start, part.end - moov.start));
    }
    copy(input.subarray(mdat.start, mdat.end));
    return ok({ bytes, width, height, durationMs });
  });
}
