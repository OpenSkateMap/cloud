import { z } from "@hono/zod-openapi";
import { type Database, schema } from "@openskatemap/db";
import { createApp } from "../src/app.ts";
import { bindings, executionContext } from "../test/support.ts";
import { renameDatabase, workerDatabase } from "./worker-database.ts";

const baseUrl = process.env.E2E_DATABASE_URL;
const worker = process.env.BUN_TEST_WORKER_ID;
export const e2eUrl = baseUrl && worker ? renameDatabase(baseUrl, (name) => workerDatabase(name, worker)) : baseUrl;

export const photosBucket = (() => {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string | undefined }>();
  return {
    objects,
    async put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }) {
      objects.set(key, { bytes: value, contentType: options?.httpMetadata?.contentType });
      return { key };
    },
    async delete(keys: string | string[]) {
      for (const key of [keys].flat()) objects.delete(key);
    },
  };
})();

// Nothing finds cities by calling out unless a suite passes its own lookup (`city-places.test.ts`).
const app = createApp({ placeLookup: null });
const env = bindings({ HYPERDRIVE: { connectionString: e2eUrl }, PHOTOS: photosBucket });

export async function call(path: string, init: RequestInit = {}, extraBindings: Record<string, unknown> = {}, via: ReturnType<typeof createApp> = app) {
  const { ctx, settle } = executionContext();
  const response = await via.request(path, init, { ...env, ...extraBindings }, ctx);
  const body = await response.json();
  await settle();
  return { status: response.status, headers: response.headers, body: body as { ok: boolean; data?: Record<string, unknown>; error?: { code: string } } };
}

export async function read<T extends z.ZodType>(data: T, path: string, init: RequestInit = {}): Promise<z.infer<T>> {
  const { status, body } = await call(path, init);
  if (status !== 200) throw new Error(`${path} answered ${status}: ${JSON.stringify(body)}`);
  return data.parse(z.object({ ok: z.literal(true), data: z.unknown() }).parse(body).data);
}

export async function createRider(db: Database, name = "E2E Rider") {
  const userId = `e2e-${crypto.randomUUID()}`;
  const token = crypto.randomUUID().replaceAll("-", "");
  const now = new Date();
  await db.insert(schema.user).values({ id: userId, name, email: `${userId}@example.com`, role: "user", createdAt: now, updatedAt: now });
  await db.insert(schema.session).values({
    id: `s-${userId}`,
    token,
    userId,
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    createdAt: now,
    updatedAt: now,
  });
  return { userId, name, bearer: { authorization: `Bearer ${token}` } };
}
