import { type FontName, kindColors, layOutSpotCard, type SpotCardContent, spotCardParts, spotCardTile } from "../site/spot-card-layout.ts";

export type SpotCardSources = {
  images: Pick<ImagesBinding, "input" | "text">;
  cover: ReadableStream<Uint8Array> | undefined;
  part: (path: string) => Promise<ReadableStream<Uint8Array>>;
  fontURL: (font: FontName) => string;
};

export const spotCardJpegQuality = 82;

// Images draws image overlays before text overlays whatever the call order, so every image goes first.
export async function composeSpotCard(content: SpotCardContent, sources: SpotCardSources) {
  const { images } = sources;
  const layout = layOutSpotCard(content);
  const { cover } = spotCardTile;
  const tile = { left: spotCardTile.left, top: spotCardTile.top };
  const frame = images.input(await sources.part(spotCardParts.frame));
  let card = images.input(await sources.part(spotCardParts.base));
  // The frame is transparent only inside the border: over the square cover it rounds the corners; without one, its background fills the hole.
  card = sources.cover
    ? card
        .draw(images.input(sources.cover).transform({ width: cover.size, height: cover.size, fit: "cover", gravity: "auto" }), { left: cover.left, top: cover.top })
        .draw(frame, tile)
    : card.draw(frame.transform({ background: kindColors[content.kind] }), tile);
  card = card.draw(images.input(await sources.part(spotCardParts.pill)), layout.pill);
  for (const run of layout.text) {
    card = card.draw(images.text(run.text, { font: { url: sources.fontURL(run.font) }, size: run.size, color: run.color }), {
      top: run.top,
      left: run.left,
    });
  }
  return card.output({ format: "image/jpeg", quality: spotCardJpegQuality });
}
