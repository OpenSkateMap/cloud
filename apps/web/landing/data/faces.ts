import { createHash } from "node:crypto";
import { createAvatar } from "@dicebear/core";
import { notionists } from "@dicebear/collection";
import sharp from "sharp";

const backgrounds = {
  andre: "c9dcff",
  lucia: "ffd9c4",
  kenji: "cdeec6",
  maya: "ffe08a",
  leo: "e2d1ff",
  sam: "ffc9d9",
} as const;

export type Face = keyof typeof backgrounds;

// Rasterized because the SVG's mix-blend-mode style attribute trips WebKit's page CSP, and 3x WebP is smaller anyway.
const render = (face: Face) =>
  sharp(Buffer.from(createAvatar(notionists, { seed: face[0]!.toUpperCase() + face.slice(1), backgroundColor: [backgrounds[face]] }).toString()))
    .resize(120)
    .webp({ quality: 80 })
    .toBuffer();

// Named by content so they can be cached as immutable.
export const faceFiles = Object.fromEntries(
  await Promise.all(
    (Object.keys(backgrounds) as Face[]).map(async (face) => {
      const bytes = await render(face);
      return [face, { name: `${face}-${createHash("sha256").update(bytes).digest("hex").slice(0, 8)}`, bytes }] as const;
    }),
  ),
) as Record<Face, { name: string; bytes: Buffer }>;

export const faceURL = (face: Face) => `/avatars/${faceFiles[face].name}.webp`;
