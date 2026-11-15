import { z } from "zod";

const { $ } = Bun;

// CI's deploy job (.github/workflows/ci.yml) from a laptop, with the cf login. Worker secrets stay as they are.
const root = new URL("../../../", import.meta.url).pathname;
const api = `${root}apps/api`;
const sha = (await $`git rev-parse --short HEAD`.cwd(root).text()).trim();

const missing = ["DATABASE_URL_MIGRATE", "DATABASE_URL_APP"].filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Set ${missing.join(" and ")}: bun --env-file=<file> run deploy`);
  process.exit(2);
}
if ((await $`git status --porcelain`.cwd(root).text()).trim()) {
  console.error("Commit first: each version is tagged with its commit");
  process.exit(2);
}

async function answers(url: string, isHealthy: (response: Response) => Promise<boolean> = async () => true) {
  for (let attempt = 1; attempt <= 10; attempt++) {
    const response = await fetch(url).catch(() => undefined);
    if (response?.ok && (await isHealthy(response))) return;
    await Bun.sleep(3000);
  }
  throw new Error(`${url} isn't answering`);
}

const VersionSchema = z.object({ version_id: z.string(), percentage: z.number() });
const DeploymentSchema = z.object({ versions: z.tuple([VersionSchema], VersionSchema) });
const DeploymentsSchema = z.object({ deployments: z.tuple([DeploymentSchema], DeploymentSchema) });

await $`bun run check`.cwd(root);
await $`bun run db:migrate`.cwd(root).env({ ...process.env, DATABASE_URL: process.env.DATABASE_URL_MIGRATE });

const listed = DeploymentsSchema.parse(await $`bunx cf workers deployments list --worker openskatemap-api`.cwd(api).json());
const live = listed.deployments[0].versions.reduce((most, version) => (version.percentage > most.percentage ? version : most)).version_id;
console.log(`live version ${live}; deploying ${sha}`);

try {
  await $`bunx cf deploy --tag ${sha} --message ${sha}`.cwd(api);
  await answers("https://api.openskatemap.app/v1/health", async (response) => z.object({ ok: z.literal(true) }).safeParse(await response.json()).success);
} catch (error) {
  console.error(`The API failed (${error instanceof Error ? error.message : "unknown"}); rolling back to ${live}`);
  const versions = JSON.stringify([{ version_id: live, percentage: 100 }]);
  await $`bunx cf workers deployments create --worker openskatemap-api --strategy percentage --versions ${versions}`.cwd(api);
  process.exit(1);
}

// The website deploys itself through Cloudflare Workers Builds on every push to main.
console.log(`deployed ${sha}`);
