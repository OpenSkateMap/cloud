import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { documents } from "./documents.ts";
import { site } from "./site.ts";
import { spotCardParts } from "./spot-card-layout.ts";

export type RenderedCard = { file: string; url: string; alt: string; bytes: Uint8Array; width: number; height: number };

/** A page's share card: its title and one line under it, rendered by scripts/share-images.ts into site/share/<name>.jpg. */
export type ShareCard = { name: string; title: string; note: string };

export const spotShareCard = { name: "spot", title: "A skater sent you a spot", note: "Open the link on an iPhone with OpenSkateMap" } as const satisfies ShareCard;

export const shareCards: readonly ShareCard[] = [...documents.map(({ slug, title, note }) => ({ name: slug, title, note })), spotShareCard];

/** 1.5× the 1200 × 630 card: sharper than 1× and still under WhatsApp's ~300 KB preview limit. */
export const sharedCardSize = { width: 1800, height: 945 } as const;

export const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

export const shareDirectory = path.join(import.meta.dirname, "share");

/** A share image rendered by scripts/share-images.ts, fingerprinted so it can be cached for good. */
export async function sharedCard(name: string, alt: string): Promise<RenderedCard> {
  const bytes = new Uint8Array(await readFile(path.join(shareDirectory, `${name}.jpg`)));
  const file = `cards/${name}.${createHash("sha256").update(bytes).digest("hex").slice(0, 10)}.jpg`;
  return { file, url: `${site.origin}/${file}`, alt, bytes, ...sharedCardSize };
}

export const cardAlt = (card: Pick<ShareCard, "title" | "note">) => `${site.name}: ${sentence(card.title)} ${sentence(card.note)}`;

/** The spot card's parts, rendered with the share images and composed by the Worker (src/spot-card.ts). */
export const spotCardPartFiles = Object.values(spotCardParts).map((part) => ({ part, source: path.join(shareDirectory, "spot-card", path.basename(part)) }));
