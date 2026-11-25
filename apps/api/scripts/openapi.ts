import { createApp, openApiInfo } from "../src/app.ts";

const document = createApp().getOpenAPI31Document(openApiInfo);
const file = Bun.file(new URL("../openapi.json", import.meta.url).pathname);
const written = `${JSON.stringify(document, null, 2)}\n`;

if (process.argv.includes("--check")) {
  if ((await file.exists()) && (await file.text()) === written) process.exit(0);
  console.error(`${file.name} doesn't match the routes: run \`bun run openapi\` and commit it`);
  process.exit(1);
}
await Bun.write(file, written);
console.log(`wrote ${file.name}`);
