export const limiter = (success: boolean) => ({ limit: async () => ({ success }) });

export function countingLimiter(budget: number) {
  const counts = new Map<string, number>();
  return {
    counts,
    async limit({ key }: { key: string }) {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { success: count <= budget };
    },
  };
}

export const unreachableDatabase = { connectionString: "postgres://nobody:nothing@127.0.0.1:1/none" };

export const bindings = (overrides: Record<string, unknown> = {}) => ({
  ADDRESS_LIMITER: limiter(true),
  API_LIMITER: limiter(true),
  AUTH_LIMITER: limiter(true),
  WRITE_LIMITER: limiter(true),
  OUTREACH_LIMITER: limiter(true),
  HYPERDRIVE: unreachableDatabase,
  API_ORIGIN: "http://localhost:8787",
  APPLE_BUNDLE_IDS: "com.ertembiyik.openskatemap,com.ertembiyik.openskatemap.dev",
  BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters-long",
  ...overrides,
});

export function executionContext() {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  return { ctx, settle: () => Promise.allSettled(pending) };
}

export async function testSigningKey() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  if (!("privateKey" in pair)) throw new Error("ECDSA key generation returns a key pair");
  const exported = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  if (!(exported instanceof ArrayBuffer)) throw new Error("A PKCS #8 export returns bytes");
  const pkcs8 = new Uint8Array(exported);
  return { key: { teamId: "TEAMID1234", keyId: "KEYID12345", privateKey: btoa(String.fromCharCode(...pkcs8)) }, publicKey: pair.publicKey };
}
