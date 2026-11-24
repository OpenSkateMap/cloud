import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanMp4 } from "../src/lib/mp4.ts";

// Made once with ffmpeg's testsrc at 96×64, 8 fps, libx264 High; see `clip-*` in this folder.
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const withMetadata = fixture("clip-metadata.mp4");

type Box = { type: string; start: number; body: number; end: number };
const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "udta"]);
const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

function boxes(bytes: Uint8Array, from = 0, to = bytes.length): Box[] {
  const found: Box[] = [];
  for (let at = from; at < to; ) {
    const size = view(bytes).getUint32(at);
    found.push({ type: String.fromCharCode(...bytes.subarray(at + 4, at + 8)), start: at, body: at + 8, end: at + size });
    at += size;
  }
  return found;
}

const allTypes = (bytes: Uint8Array, from = 0, to = bytes.length): string[] =>
  boxes(bytes, from, to).flatMap((box) => [box.type, ...(CONTAINERS.has(box.type) ? allTypes(bytes, box.body, box.end) : [])]);

function find(bytes: Uint8Array, path: string[], from = 0, to = bytes.length): Box {
  const [type, ...rest] = path;
  const box = boxes(bytes, from, to).find((candidate) => candidate.type === type);
  if (!box) throw new Error(`no ${type}`);
  return rest.length === 0 ? box : find(bytes, rest, box.body, box.end);
}

const stbl = ["moov", "trak", "mdia", "minf", "stbl"];
function chunkOffsets(bytes: Uint8Array) {
  const stco = find(bytes, [...stbl, "stco"]);
  const count = view(bytes).getUint32(stco.body + 4);
  return Array.from({ length: count }, (_, index) => view(bytes).getUint32(stco.body + 8 + index * 4));
}

const contains = (bytes: Uint8Array, text: string) => Buffer.from(bytes).includes(text);

/** A copy of `bytes` with `change` applied to it. */
function edited(bytes: Uint8Array, change: (copy: Uint8Array) => void) {
  const copy = bytes.slice();
  change(copy);
  return copy;
}

describe("cleanMp4", () => {
  test("keeps only ftyp, the movie's header and its video track, and the media data; metadata goes", () => {
    expect(allTypes(withMetadata)).toContain("udta");
    expect(contains(withMetadata, "Secret")).toBe(true);

    const clean = cleanMp4(withMetadata)._unsafeUnwrap();
    expect([clean.width, clean.height, clean.durationMs]).toEqual([96, 64, 2000]);
    expect(boxes(clean.bytes).map((box) => box.type)).toEqual(["ftyp", "moov", "mdat"]);
    expect(boxes(clean.bytes, find(clean.bytes, ["moov"]).body, find(clean.bytes, ["moov"]).end).map((box) => box.type)).toEqual(["mvhd", "trak"]);
    expect(allTypes(clean.bytes).filter((type) => type === "udta" || type === "meta" || type === "free")).toEqual([]);
    expect([contains(clean.bytes, "Secret"), contains(clean.bytes, "+51.5")]).toEqual([false, false]);
  });

  test("moves every chunk offset with the media data, so each still points at the same sample bytes", () => {
    const clean = cleanMp4(withMetadata)._unsafeUnwrap().bytes;
    const [before, after] = [find(withMetadata, ["mdat"]), find(clean, ["mdat"])];
    expect(after.start).toBeLessThan(before.start);
    expect(clean.subarray(after.start)).toEqual(withMetadata.subarray(before.start, before.end));

    const [oldOffsets, newOffsets] = [chunkOffsets(withMetadata), chunkOffsets(clean)];
    expect(newOffsets.map((offset) => offset - after.start)).toEqual(oldOffsets.map((offset) => offset - before.start));
    const [first, moved] = [oldOffsets[0]!, newOffsets[0]!];
    expect(clean.subarray(moved, moved + 32)).toEqual(withMetadata.subarray(first, first + 32));
  });

  test("zeroes the recording times in the movie, track and media headers", () => {
    const recorded = edited(withMetadata, (copy) => {
      for (const path of [["moov", "mvhd"], ["moov", "trak", "tkhd"], ["moov", "trak", "mdia", "mdhd"]]) {
        const box = find(copy, path);
        view(copy).setUint32(box.body + 4, 3_900_000_000);
        view(copy).setUint32(box.body + 8, 3_900_000_001);
      }
    });
    const clean = cleanMp4(recorded)._unsafeUnwrap().bytes;
    for (const path of [["moov", "mvhd"], ["moov", "trak", "tkhd"], ["moov", "trak", "mdia", "mdhd"]]) {
      const box = find(clean, path);
      expect([view(clean).getUint32(box.body + 4), view(clean).getUint32(box.body + 8)]).toEqual([0, 0]);
    }
  });

  test("leaves a clean clip as it is", () => {
    const clean = cleanMp4(withMetadata)._unsafeUnwrap().bytes;
    expect(cleanMp4(clean)._unsafeUnwrap().bytes).toEqual(clean);
  });

  test.skipIf(!Bun.which("ffprobe"))("ffprobe reads the cleaned clip's size and duration, and no tags", async () => {
    const folder = await mkdtemp(join(tmpdir(), "clean-mp4-"));
    try {
      const path = join(folder, "clean.mp4");
      await writeFile(path, cleanMp4(withMetadata)._unsafeUnwrap().bytes);
      const probe = Bun.spawnSync(["ffprobe", "-v", "error", "-show_entries", "format=duration:format_tags:stream=width,height,codec_name", "-of", "json", path]);
      expect(probe.exitCode).toBe(0);
      const { streams, format } = JSON.parse(probe.stdout.toString()) as { streams: object[]; format: { duration: string; tags?: Record<string, string> } };
      expect(streams).toEqual([{ codec_name: "h264", width: 96, height: 64 }]);
      expect(Number(format.duration)).toBeCloseTo(2, 2);
      expect(Object.keys(format.tags ?? {}).filter((tag) => tag === "title" || tag === "location")).toEqual([]);
      const decoded = Bun.spawnSync(["ffmpeg", "-v", "error", "-i", path, "-f", "null", "-"]);
      expect([decoded.exitCode, decoded.stderr.toString()]).toEqual([0, ""]);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  test("swaps the size when the track's matrix turns the picture a quarter", () => {
    const turned = edited(withMetadata, (copy) => {
      const matrix = find(copy, ["moov", "trak", "tkhd"]).body + 40;
      [0, 0x10000, 0, -0x10000, 0].forEach((value, index) => view(copy).setInt32(matrix + index * 4, value));
    });
    expect(cleanMp4(turned)._unsafeUnwrap()).toMatchObject({ width: 64, height: 96 });
  });

  test("refuses sound, a late index, too long, too large, other codecs and tracks, and stray chunks", () => {
    const refusal = (bytes: Uint8Array) => cleanMp4(bytes)._unsafeUnwrapErr();
    expect(refusal(fixture("clip-audio.mp4"))).toContain("without sound");
    expect(refusal(fixture("clip-moov-last.mp4"))).toContain("faststart");
    expect(refusal(fixture("clip-17s.mp4"))).toBe("the clip is longer than 16 s");
    const huge = edited(withMetadata, (copy) => view(copy).setUint32(find(copy, ["moov", "trak", "tkhd"]).body + 76, 4000 << 16));
    expect(refusal(huge)).toContain("too large");
    const hevc = edited(withMetadata, (copy) => copy.set(Buffer.from("hvc1"), find(copy, [...stbl, "stsd"]).body + 12));
    expect(refusal(hevc)).toBe("the video isn't H.264");
    const timedMetadata = edited(withMetadata, (copy) => copy.set(Buffer.from("meta"), find(copy, ["moov", "trak", "mdia", "hdlr"]).body + 8));
    expect(refusal(timedMetadata)).toContain("isn't video");
    const stray = edited(withMetadata, (copy) => view(copy).setUint32(find(copy, [...stbl, "stco"]).body + 8, 40));
    expect(refusal(stray)).toContain("outside its media data");
  });

  test("refuses what isn't one whole progressive MP4", () => {
    const refusal = (bytes: Uint8Array) => cleanMp4(bytes)._unsafeUnwrapErr();
    expect(refusal(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]))).toBe("not an MP4");
    expect(refusal(withMetadata.subarray(0, withMetadata.length - 10))).toBe("malformed MP4 box");
    expect(refusal(new Uint8Array([...withMetadata, 0, 0, 0, 8, ...Buffer.from("moof")]))).toContain("fragmented");
    const toTheEnd = edited(withMetadata, (copy) => view(copy).setUint32(find(copy, ["mdat"]).start, 0));
    expect(refusal(toTheEnd)).toBe("malformed MP4 box");
  });
});
