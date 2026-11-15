import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { marked } from "marked";
import { type Card, renderCard, renderSpotCardParts, sharedCard } from "./cards.ts";
import { cardFonts } from "./fonts.ts";
import { landingPolicy, layout, securityHeaders, shareTags } from "./layout.ts";
import { documents } from "./documents.ts";
import { contactText, site } from "./site.ts";

const cards = {
  spot: {
    name: "spot",
    lines: ["A skater sent", "you a spot"],
    note: "Open the link on an iPhone with OpenSkateMap",
    action: "See the spot",
  },
} as const satisfies Record<string, Card>;

const contentDirectory = path.join(import.meta.dirname, "../content");
const fontDirectory = path.join(import.meta.dirname, "../fonts");

const headerLines = (headers: Record<string, string>) =>
  Object.entries(headers)
    .map(([name, value]) => `  ${name}: ${value}`)
    .join("\n");

export async function documentMarkdown(slug: string, contact: string = site.contact) {
  const source = await readFile(path.join(contentDirectory, `${slug}.md`), "utf8");
  return source.replaceAll("{{contact}}", contactText(contact));
}

const homeDescription = "The street spots in your city on one map, checked by locals who skate them.";

const contentSignal = "search=yes, ai-input=yes, ai-train=yes";
const aiCrawlers = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-User", "Claude-SearchBot", "PerplexityBot", "Perplexity-User", "Google-Extended", "Applebot-Extended", "CCBot"];
const robots = `# Content Signals (https://contentsignals.org/): search builds an index, ai-input answers in real time, ai-train trains models.
User-agent: *
Content-Signal: ${contentSignal}
Allow: /

${aiCrawlers.map((crawler) => `User-agent: ${crawler}`).join("\n")}
Content-Signal: ${contentSignal}
Allow: /

Sitemap: ${site.origin}/sitemap-index.xml
`;

function withShareTags(html: string, card: { url: string; alt: string }) {
  if (!html.includes("</head>")) throw new Error("The landing page has no </head> to put its share tags in");
  return html.replace("</head>", `${shareTags({ title: site.name, description: homeDescription, card, url: `${site.origin}/` })}\n<link rel="alternate" type="text/markdown" href="/index.md">\n</head>`);
}

export async function buildPages(directory: string, options: { home: string; contact?: string }) {
  const contact = options.contact ?? site.contact;
  await rm(path.join(directory, "cards"), { recursive: true, force: true });
  await mkdir(path.join(directory, "cards/spot"), { recursive: true });
  await mkdir(path.join(directory, "fonts"), { recursive: true });
  const [home, spot, texts, spotCardParts] = await Promise.all([
    sharedCard("home", `${site.name}: All over town. The street spots in your city on one map, with photo pins and curators' notes.`, { width: 1800, height: 945 }),
    renderCard(cards.spot),
    Promise.all(documents.map(async (document) => ({ ...document, card: await renderCard({ name: document.slug, ...document.card }) }))),
    renderSpotCardParts(),
  ]);
  // One text for agents: llms.txt, and the home page's Markdown twin.
  const llms = `# ${site.name}

> ${homeDescription} Free on iPhone.

- [Join the beta on TestFlight](${site.testFlight})
- [Source code on GitHub](${site.github})

## Pages

${documents.map((document) => `- [${document.title}](${site.origin}/${document.slug}.md): ${document.description}`).join("\n")}
`;
  const files: Record<string, string | Uint8Array> = {
    "index.html": withShareTags(options.home, home),
    "llms.txt": llms,
    "index.md": `${llms}
## What it does

- **One map of street spots.** Spots live in Instagram stories, old video parts and someone's DMs. OpenSkateMap puts them on one map, each with photos, what's there to skate and the clips filmed at it.
- **How a spot is right now.** Locals mark a spot skateable, knobbed, busty or demolished, so you don't push across town for nothing.
- **Checked by locals.** Every new spot and every change goes past a curator who skates that city. They approve it, fix it or turn it down, with a reason you can read.
- **Add what's missing.** Add a spot from where you're standing, with a photo, and hear when it's on the map.
- **Lists for every trip.** Save spots to a list and share it. Private spots stay between the people you pick.
- **Free, no ads.** Every spot and every feature is free, and the map works offline.
`,
    "robots.txt": robots,
    "spot.html": layout({
      title: `A spot on ${site.name}`,
      description: "A skate spot shared from OpenSkateMap.",
      card: spot,
      noindex: true,
      body: `<h1>A spot on ${site.name}</h1>
<p class="lede">Spots are shared with skaters signed in to ${site.name}. Open this link on an iPhone with the app to see it.</p>
<p class="soon">Coming to the App Store soon</p>`,
    }),
    "collection.html": layout({
      title: `A collection on ${site.name}`,
      description: "A collection of skate spots shared from OpenSkateMap.",
      card: spot,
      noindex: true,
      body: `<h1>A collection on ${site.name}</h1>
<p class="lede">Collections are shared with skaters signed in to ${site.name}. Open this link on an iPhone with the app to see it.</p>
<p class="soon">Coming to the App Store soon</p>`,
    }),
    "apple-app-site-association.json": `${JSON.stringify(
      {
        applinks: {
          details: [
            {
              appIDs: site.appIDs,
              components: [
                { "/": "/spots/*", comment: "A spot opens in the app" },
                { "/": "/collections/*", comment: "A collection opens in the app" },
              ],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
    // Served by path: Apple fetches the association file without an extension.
    _redirects: `/.well-known/apple-app-site-association /apple-app-site-association.json 200
/collections/* /collection 200
`,
    "404.html": layout({
      title: `Not found · ${site.name}`,
      description: "This page doesn't exist.",
      card: home,
      body: `<h1>Nothing here</h1>\n<p><a href="/">Back to ${site.name}</a></p>`,
    }),
    _headers: `/*
${headerLines(securityHeaders())}
  Content-Signal: ${contentSignal}
  Link: </llms.txt>; rel="describedby"; type="text/markdown"
  Link: </sitemap-index.xml>; rel="sitemap"; type="application/xml"
/llms.txt
  Content-Type: text/plain; charset=utf-8
/*.md
  Content-Type: text/markdown; charset=utf-8
/
  ! Content-Security-Policy
  Content-Security-Policy: ${landingPolicy}
/collections/*
  X-Robots-Tag: noindex
/assets/*
  Cache-Control: public, max-age=31536000, immutable
/avatars/*
  Cache-Control: public, max-age=31536000, immutable
/cards/*
  Cache-Control: public, max-age=31536000, immutable
/cards/spot/*
  ! Cache-Control
  Cache-Control: public, max-age=604800
/favicon.ico
  Cache-Control: public, max-age=86400
/favicon.png
  Cache-Control: public, max-age=86400
/apple-touch-icon.png
  Cache-Control: public, max-age=86400
/fonts/*
  Cache-Control: public, max-age=604800
`,
    ...spotCardParts,
  };
  for (const card of [home, spot, ...texts.map((document) => document.card)]) {
    files[card.file] = card.bytes;
  }
  for (const file of [...Object.values(cardFonts), "OFL.txt"]) {
    await copyFile(path.join(fontDirectory, file), path.join(directory, "fonts", file));
  }
  for (const { slug, title, description, card } of texts) {
    const markdown = await documentMarkdown(slug, contact);
    files[`${slug}.md`] = markdown;
    files[`${slug}.html`] = layout({
      title: `${title} · ${site.name}`,
      description,
      body: await marked.parse(markdown),
      card,
      url: `${site.origin}/${slug}`,
      markdownTwin: `/${slug}.md`,
    });
  }
  await Promise.all(Object.entries(files).map(([name, text]) => writeFile(path.join(directory, name), text)));
  return [...Object.keys(files), ...[...Object.values(cardFonts), "OFL.txt"].map((file) => `fonts/${file}`)];
}
