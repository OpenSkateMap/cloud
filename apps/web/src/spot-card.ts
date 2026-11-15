import { type FontName, layOutSpotCard, type SpotCardContent, spotCardParts, spotCardTile } from "../site/spot-card-layout.ts";

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
  const photo = sources.cover
    ? images.input(sources.cover).transform({ width: cover.size, height: cover.size, fit: "cover", gravity: "auto" })
    : images.input(await sources.part(spotCardParts.empty(content.kind)));
  // The frame is transparent only inside the border, so drawn over the square photo it rounds its corners.
  let card = images
    .input(await sources.part(spotCardParts.base))
    .draw(photo, { left: cover.left, top: cover.top })
    .draw(images.input(await sources.part(spotCardParts.frame)), { left: spotCardTile.left, top: spotCardTile.top })
    .draw(images.input(await sources.part(spotCardParts.pill)), layout.pill);
  for (const run of layout.text) {
    card = card.draw(images.text(run.text, { font: { url: sources.fontURL(run.font) }, size: run.size, color: run.color }), {
      top: run.top,
      left: run.left,
    });
  }
  return card.output({ format: "image/jpeg", quality: spotCardJpegQuality });
}
