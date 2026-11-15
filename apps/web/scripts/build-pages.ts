import { execFileSync } from "node:child_process";
import { cp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { buildPages } from "../site/pages.ts";

const root = path.join(import.meta.dirname, "..");
const pagesDirectory = path.join(root, ".pages");
const landingDirectory = path.join(root, ".site");

execFileSync("bun", ["run", "build"], { cwd: path.join(root, "landing"), stdio: "inherit" });
await rm(pagesDirectory, { recursive: true, force: true });
await cp(landingDirectory, pagesDirectory, { recursive: true, filter: (file) => file !== path.join(landingDirectory, "index.html") });
await buildPages(pagesDirectory, { home: await readFile(path.join(landingDirectory, "index.html"), "utf8") });
