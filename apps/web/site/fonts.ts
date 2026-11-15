export const cardFonts = {
  display: "MonaSansDisplayCondensed-Black.ttf",
  text: "MonaSans-Medium.ttf",
} as const;

export type CardFont = keyof typeof cardFonts;
