import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";
import { documents } from "../site/documents.ts";

export default defineConfig({
  site: "https://openskatemap.app",
  srcDir: ".",
  publicDir: "./public",
  outDir: "../.site",
  output: "static",
  trailingSlash: "ignore",
  devToolbar: { enabled: false },
  markdown: { syntaxHighlight: false },
  integrations: [sitemap({ customPages: documents.map((document) => `https://openskatemap.app/${document.slug}`) })],
  // The stylesheet is inlined so nothing blocks the first paint; security.csp hashes it into the page's <meta> policy.
  build: { format: "directory", assets: "assets", inlineStylesheets: "always" },
  vite: { build: { assetsInlineLimit: 0 } },
  security: {
    csp: {
      directives: ["default-src 'none'", "img-src 'self'", "connect-src 'self'", "base-uri 'none'", "form-action 'none'"],
      scriptDirective: { resources: ["'self'"] },
    },
  },
});
