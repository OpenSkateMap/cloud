import { createApp, openApiInfo } from "../src/app.ts";

const document = createApp().getOpenAPI31Document(openApiInfo);
const path = new URL("../openapi.json", import.meta.url).pathname;
await Bun.write(path, `${JSON.stringify(document, null, 2)}\n`);
console.log(`wrote ${path}`);
