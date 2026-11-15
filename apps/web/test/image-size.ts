import { readFile } from "node:fs/promises";

// PNG keeps its size in the IHDR chunk; JPEG in its frame header (SOFn), height first.
export async function imageSize(file: string) {
  const bytes = new Uint8Array(await readFile(file));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] === 0x89) return { width: view.getUint32(16), height: view.getUint32(20) };
  for (let at = 2; at < bytes.length; at += 2 + view.getUint16(at + 2)) {
    const marker = view.getUint8(at + 1);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: view.getUint16(at + 7), height: view.getUint16(at + 5) };
  }
  throw new Error(`No frame header in ${file}`);
}
