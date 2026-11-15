import { site } from "./site.ts";

export type ShareImage = { url: string; alt: string; width?: number; height?: number };

export const shareImageSize = { width: 1200, height: 630 } as const;

export function securityHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": `default-src 'none'; style-src '${pageStylesheet.hash}'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  } as const;
}

// The landing page carries its own <meta> policy (Astro's security.csp hashes its inline styles); a <meta> policy can't set frame-ancestors, so the header does.
export const landingPolicy = "frame-ancestors 'none'";

// The pages inline this stylesheet; its hash is their whole style-src (a test keeps it in step with the text).
export const pageStylesheet = { hash: "sha256-xLx95rNWrO0ewTTBkyi7Hc0c5xSEGv2ec518v19JquY=", text: `
:root { color-scheme: light dark; --bg: #fff; --fg: #111; --muted: #6b6b6b; --rule: #e6e6e6; --link: #111; }
@media (prefers-color-scheme: dark) { :root { --bg: #0b0b0b; --fg: #f2f2f2; --muted: #9a9a9a; --rule: #262626; --link: #fff; } }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 17px/1.6 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
.page { max-width: 680px; margin: 0 auto; padding: max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(32px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left)); }
header { padding: 20px 0 8px; }
.wordmark { font-weight: 650; font-stretch: 125%; letter-spacing: 0.01em; color: var(--fg); text-decoration: none; }
main { padding: 8px 0 24px; }
h1 { font-size: 34px; line-height: 1.15; margin: 24px 0 8px; letter-spacing: -0.01em; }
h2 { font-size: 20px; line-height: 1.3; margin: 36px 0 8px; }
p, li { color: var(--fg); }
em { color: var(--muted); }
ul { padding-left: 1.2em; }
li { margin: 6px 0; }
a { color: var(--link); text-decoration-thickness: 1px; text-underline-offset: 3px; }
footer { border-top: 1px solid var(--rule); padding-top: 16px; color: var(--muted); font-size: 15px; }
footer a { color: var(--muted); }
.display { font-size: min(12vw, 84px); line-height: 0.9; font-weight: 800; font-stretch: 75%; text-transform: uppercase; letter-spacing: -0.01em; margin: 18vh 0 20px; }
.display span { display: block; white-space: nowrap; }
.lede { font-size: 20px; line-height: 1.45; margin: 0 0 8px; max-width: 30ch; }
.soon { color: var(--muted); margin: 0 0 48px; }
.meta { color: var(--muted); margin: 0 0 20px; }
.card { display: block; width: 100%; height: auto; border-radius: 16px; margin: 0 0 24px; }
` };

export const escapeHTML = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export function shareTags(options: { title: string; description: string; card: ShareImage; url?: string }) {
  const tags: [string, string, string][] = [
    ["property", "og:type", "website"],
    ["property", "og:site_name", site.name],
    ["property", "og:title", options.title],
    ["property", "og:description", options.description],
    ...(options.url === undefined ? [] : [["property", "og:url", options.url] as [string, string, string]]),
    ["property", "og:image", options.card.url],
    ["property", "og:image:type", "image/jpeg"],
    ["property", "og:image:width", String(options.card.width ?? shareImageSize.width)],
    ["property", "og:image:height", String(options.card.height ?? shareImageSize.height)],
    ["property", "og:image:alt", options.card.alt],
    ["name", "twitter:card", "summary_large_image"],
    ["name", "twitter:image:alt", options.card.alt],
  ];
  return tags.map(([attribute, key, value]) => `<meta ${attribute}="${key}" content="${escapeHTML(value)}">`).join("\n");
}

export function layout(options: {
  title: string;
  description: string;
  body: string;
  card: ShareImage;
  url?: string;
  markdownTwin?: string;
  noindex?: boolean;
}) {
  const alternate = options.markdownTwin
    ? `<link rel="alternate" type="text/markdown" href="${options.markdownTwin}">`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${escapeHTML(options.title)}</title>
<meta name="description" content="${escapeHTML(options.description)}">
${options.noindex ? '<meta name="robots" content="noindex">\n' : ""}${shareTags(options)}
${options.url === undefined ? "" : `<link rel="canonical" href="${escapeHTML(options.url)}">\n`}${alternate}
<style>${pageStylesheet.text}</style>
<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">
<link rel="icon" type="image/png" href="/favicon.png" sizes="96x96">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
</head>
<body>
<div class="page">
<header><a class="wordmark" href="/">${site.name}</a></header>
<main>
${options.body}
</main>
<footer><a href="/terms">Terms of Use</a> · <a href="/privacy">Privacy Policy</a></footer>
</div>
</body>
</html>
`;
}

