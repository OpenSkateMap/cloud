import { Client } from "pg";
import { renameDatabase, workerDatabase } from "../e2e/worker-database.ts";

const ownerUrl = process.env.DATABASE_URL;
const appUrl = process.env.E2E_DATABASE_URL;
if (!ownerUrl || !appUrl) {
  console.error("Set DATABASE_URL (a role that may create databases) and E2E_DATABASE_URL (the app role the tests connect as)");
  process.exit(2);
}

const workers = Number(process.env.E2E_WORKERS ?? Math.min(navigator.hardwareConcurrency, 8));
const run = `${new URL(appUrl).pathname.slice(1)}_e2e_${process.pid}`;
const workerNames = Array.from({ length: workers }, (_, index) => workerDatabase(run, index + 1));

async function asOwner(statement: string) {
  const client = new Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}

// Ctrl-C reaches bun test too; this process waits for it, then drops the databases.
process.on("SIGINT", () => {});

let exitCode = 1;
try {
  await asOwner(`create database "${run}"`);
  const { DATABASE_URL_APP: _appRoleSettings, ...env } = process.env;
  const migrate = Bun.spawn(["bun", "run", "src/migrate.ts"], {
    cwd: new URL("../../../packages/db", import.meta.url).pathname,
    env: { ...env, DATABASE_URL: renameDatabase(ownerUrl, () => run) },
    stdout: "ignore",
    stderr: "inherit",
  });
  if ((await migrate.exited) !== 0) throw new Error("Migrating the template database failed");
  // Eight clones took ~0.2 s together on a laptop; migrating each takes ~0.5 s.
  await Promise.all(workerNames.map((name) => asOwner(`create database "${name}" template "${run}"`)));

  const tests = Bun.spawn(["bun", "test", `--parallel=${workers}`, "./e2e", ...process.argv.slice(2)], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, E2E_DATABASE_URL: renameDatabase(appUrl, () => run) },
    stdio: ["inherit", "inherit", "inherit"],
  });
  exitCode = await tests.exited;
} finally {
  await Promise.all([run, ...workerNames].map((name) => asOwner(`drop database if exists "${name}" with (force)`)));
}
process.exit(exitCode);
