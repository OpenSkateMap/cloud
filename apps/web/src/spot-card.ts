import { type FontName, layOutSpotCard, type SpotCardContent, spotCardParts, spotCardSize } from "../site/spot-card-layout.ts";

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
  let card = sources.cover
    ? images.input(sources.cover).transform({ ...spotCardSize, fit: "cover", gravity: "auto" })
    : images.input(await sources.part(spotCardParts.base(content.kind)));
  card = card
    .draw(images.input(await sources.part(spotCardParts.grain)), { repeat: true })
    .draw(images.input(await sources.part(spotCardParts.frame)), { top: 0, left: 0 });
  for (const run of layOutSpotCard(content)) {
    card = card.draw(images.text(run.text, { font: { url: sources.fontURL(run.font) }, size: run.size, color: run.color }), {
      top: run.top,
      left: run.left,
    });
  }
  return card.output({ format: "image/jpeg", quality: spotCardJpegQuality });
}
