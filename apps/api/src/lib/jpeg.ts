import { err, ok, type Result } from "./result.ts";

export interface CleanJpeg {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
}

const MAX_SIDE = 8192;
const MAX_PIXELS = 40_000_000;

const SOS = 0xda;
const EOI = 0xd9;
const DHT = 0xc4;
const DAC = 0xcc;
const DQT = 0xdb;
const DRI = 0xdd;
const APP0 = 0xe0;
const APP2 = 0xe2;
const APP14 = 0xee;

const isStartOfFrame = (marker: number) => marker >= 0xc0 && marker <= 0xcf && ![DHT, 0xc8, DAC].includes(marker);

const startsWith = (bytes: Uint8Array, at: number, tag: string) =>
  [...tag].every((character, index) => bytes[at + index] === character.charCodeAt(0));

function isNeeded(marker: number, bytes: Uint8Array, payload: number) {
  if (isStartOfFrame(marker) || marker === DHT || marker === DAC || marker === DQT || marker === DRI) return true;
  if (marker === APP0) return startsWith(bytes, payload, "JFIF\0");
  if (marker === APP2) return startsWith(bytes, payload, "ICC_PROFILE\0");
  if (marker === APP14) return startsWith(bytes, payload, "Adobe");
  return false;
}

// Exif orientation goes with the rest of the metadata: uploads must already be upright.
export function cleanJpeg(input: Uint8Array): Result<CleanJpeg, string> {
  if (input[0] !== 0xff || input[1] !== 0xd8) return err("not a JPEG");
  const kept: Uint8Array[] = [input.subarray(0, 2)];
  let size: { width: number; height: number } | undefined;
  let scanned = false;
  let offset = 2;
  for (;;) {
    if (offset + 2 > input.length) return err("the JPEG ends before its end marker");
    if (input[offset] !== 0xff) return err("malformed JPEG segment");
    const marker = input[offset + 1] ?? 0;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === EOI) {
      if (!scanned) return err("the JPEG has no image data");
      kept.push(input.subarray(offset, offset + 2));
      break;
    }
    if (offset + 4 > input.length) return err("the JPEG ends before its end marker");
    const length = ((input[offset + 2] ?? 0) << 8) | (input[offset + 3] ?? 0);
    const end = offset + 2 + length;
    if (length < 2 || end > input.length) return err("malformed JPEG segment");
    if (isStartOfFrame(marker) && length >= 7) {
      const height = ((input[offset + 5] ?? 0) << 8) | (input[offset + 6] ?? 0);
      const width = ((input[offset + 7] ?? 0) << 8) | (input[offset + 8] ?? 0);
      size = { width, height };
    }
    if (marker === SOS) {
      // FF 00 is an escaped byte and FF D0–D7 are restart markers: both are part of the entropy-coded data.
      let next = end;
      while (next < input.length) {
        if (input[next] !== 0xff) {
          next += 1;
          continue;
        }
        const following = input[next + 1];
        if (following === 0x00 || (following !== undefined && following >= 0xd0 && following <= 0xd7)) next += 2;
        else if (following === 0xff) next += 1;
        else break;
      }
      kept.push(input.subarray(offset, next));
      scanned = true;
      offset = next;
      continue;
    }
    if (isNeeded(marker, input, offset + 4)) kept.push(input.subarray(offset, end));
    offset = end;
  }
  if (!size || size.width === 0 || size.height === 0) return err("no image size in the JPEG header");
  if (size.width > MAX_SIDE || size.height > MAX_SIDE || size.width * size.height > MAX_PIXELS) {
    return err(`the image is too large (${size.width}×${size.height}); send at most ${MAX_SIDE} px per side`);
  }
  const bytes = new Uint8Array(kept.reduce((total, part) => total + part.length, 0));
  kept.reduce((at, part) => (bytes.set(part, at), at + part.length), 0);
  return ok({ bytes, ...size });
}
