// The legal and support pages, rendered from content/*.md by buildPages and listed in the landing's sitemap.
export const documents = [
  { slug: "privacy", title: "Privacy Policy", description: "OpenSkateMap's privacy policy.", card: { lines: ["Privacy", "Policy"], note: "What OpenSkateMap keeps, and why" } },
  { slug: "terms", title: "Terms of Use", description: "OpenSkateMap's terms of use.", card: { lines: ["Terms", "of use"], note: "The rules for using OpenSkateMap" } },
  { slug: "support", title: "Support", description: "Help with OpenSkateMap, and how to reach us.", card: { lines: ["Help and", "support"], note: "Questions about OpenSkateMap" } },
] as const;
