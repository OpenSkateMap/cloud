import { describe, expect, test } from "bun:test";
import { cleanJpeg } from "../src/lib/jpeg.ts";

const ascii = (text: string) => [...text].map((character) => character.charCodeAt(0));
const segment = (marker: number, payload: number[]) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
const frame = (width: number, height: number, marker = 0xc0) =>
  segment(marker, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0]);
const jfif = segment(0xe0, [...ascii("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const jfxxThumbnail = segment(0xe0, [...ascii("JFXX\0"), 0x10, 0xff, 0xd8]);
const icc = segment(0xe2, [...ascii("ICC_PROFILE\0"), 1, 1]);
const mpf = segment(0xe2, [...ascii("MPF\0"), 0, 0]);
const adobe = segment(0xee, [...ascii("Adobe"), 0, 100, 0, 0, 0, 0, 1]);
const quantization = segment(0xdb, [0, 1, 2, 3]);
const huffman = segment(0xc4, [0, 1, 2, 3]);
const exif = segment(0xe1, [...ascii("Exif\0\0"), ...ascii("GPS")]);
const xmp = segment(0xe1, ascii("http://ns.adobe.com/xap/1.0/\0"));
const iptc = segment(0xed, ascii("Photoshop 3.0"));
const makerNote = segment(0xea, ascii("vendor"));
const comment = segment(0xfe, ascii("hi"));
const scan = [0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, 0x12, 0xff, 0x00, 0xe1, 0xff, 0xd0, 0x34];
const eoi = [0xff, 0xd9];
const jpeg = (...parts: number[][]) => new Uint8Array([0xff, 0xd8, ...parts.flat()]);

describe("cleanJpeg", () => {
  test("keeps only what decodes the image, byte for byte, and reads the size", () => {
    const input = jpeg(jfif, exif, xmp, icc, mpf, iptc, makerNote, comment, jfxxThumbnail, adobe, quantization, frame(4032, 3024), huffman, scan, eoi);
    const clean = cleanJpeg(input)._unsafeUnwrap();
    expect(clean).toEqual({ bytes: jpeg(jfif, icc, adobe, quantization, frame(4032, 3024), huffman, scan, eoi), width: 4032, height: 3024 });
  });

  test("leaves a clean JPEG as it is", () => {
    const input = jpeg(jfif, quantization, frame(10, 20), huffman, scan, eoi);
    expect(cleanJpeg(input)._unsafeUnwrap().bytes).toEqual(input);
  });

  test("walks every scan of a progressive JPEG and drops metadata between scans", () => {
    const input = jpeg(frame(900, 1200, 0xc2), huffman, scan, exif, huffman, scan, comment, scan, eoi);
    const clean = cleanJpeg(input)._unsafeUnwrap();
    expect(clean).toEqual({ bytes: jpeg(frame(900, 1200, 0xc2), huffman, scan, huffman, scan, scan, eoi), width: 900, height: 1200 });
  });

  test("cuts everything after the end of the image, such as an appended gain map with its own Exif", () => {
    const appended = [0xff, 0xd8, ...exif, ...frame(10, 10), ...scan, ...eoi];
    const clean = cleanJpeg(jpeg(jfif, mpf, frame(10, 10), scan, eoi, appended))._unsafeUnwrap();
    expect(clean.bytes).toEqual(jpeg(jfif, frame(10, 10), scan, eoi));
  });

  test("refuses images too large to decode safely", () => {
    expect(cleanJpeg(jpeg(frame(65535, 65535), scan, eoi))._unsafeUnwrapErr()).toContain("too large");
    expect(cleanJpeg(jpeg(frame(8000, 6000), scan, eoi))._unsafeUnwrapErr()).toContain("too large");
    expect(cleanJpeg(jpeg(frame(8192, 4096), scan, eoi)).isOk()).toBe(true);
  });

  test("refuses what is not a whole, sized JPEG", () => {
    expect(cleanJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))._unsafeUnwrapErr()).toBe("not a JPEG");
    expect(cleanJpeg(jpeg(jfif, scan, eoi))._unsafeUnwrapErr()).toBe("no image size in the JPEG header");
    expect(cleanJpeg(jpeg(jfif, frame(10, 10), eoi))._unsafeUnwrapErr()).toBe("the JPEG has no image data");
    expect(cleanJpeg(jpeg(jfif, frame(10, 10), scan))._unsafeUnwrapErr()).toBe("the JPEG ends before its end marker");
    expect(cleanJpeg(jpeg([0x00, 0x01, 0x02, 0x03]))._unsafeUnwrapErr()).toBe("malformed JPEG segment");
    expect(cleanJpeg(jpeg([0xff, 0xe0, 0x40, 0x00, 0x01]))._unsafeUnwrapErr()).toBe("malformed JPEG segment");
  });
});
