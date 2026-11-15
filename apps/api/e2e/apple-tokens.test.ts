import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Database, openDatabase, schema } from "@openskatemap/db";
import { eq } from "drizzle-orm";
import type { AppleTokenSettings } from "../src/lib/auth-settings.ts";
import { rememberAppleToken, revokeAppleToken } from "../src/services/apple-tokens.ts";
import { bindings, testSigningKey } from "../test/support.ts";
import { call, createRider, e2eUrl } from "./support.ts";

const { appleToken, user } = schema;
const RELEASE = "com.ertembiyik.openskatemap";
const DEV = "com.ertembiyik.openskatemap.dev";
const identityToken = (aud: string) => `h.${btoa(JSON.stringify({ aud })).replaceAll("=", "")}.s`;

function fakeApple(refreshToken: string, status = 200) {
  const calls: { url: string; form: Record<string, string> }[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    calls.push({ url, form: Object.fromEntries(new URLSearchParams(String(init?.body))) });
    return new Response(JSON.stringify({ refresh_token: refreshToken }), { status });
  };
  return { calls, fetcher };
}

describe.skipIf(!e2eUrl)("Apple tokens (database)", () => {
  const database = e2eUrl ? openDatabase(e2eUrl) : undefined;
  let db: Database;
  let settings: AppleTokenSettings;
  let rider: Awaited<ReturnType<typeof createRider>>;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    db = (await database!).db;
    rider = await createRider(db, "Apple Rider");
    const { key } = await testSigningKey();
    settings = { key, secret: String(bindings().BETTER_AUTH_SECRET), bundleIds: [RELEASE, DEV] };
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await db.delete(user).where(eq(user.id, rider.userId));
    await (await database!).close();
  });

  test("the refresh token is kept encrypted, per account, for the app that signed in", async () => {
    const first = fakeApple("r-release");
    expect((await rememberAppleToken(db, settings, { userId: rider.userId, idToken: identityToken(RELEASE), authorizationCode: "c1" }, first.fetcher)).isOk()).toBe(true);
    const second = fakeApple("r-dev");
    expect((await rememberAppleToken(db, settings, { userId: rider.userId, idToken: identityToken(DEV), authorizationCode: "c2" }, second.fetcher)).isOk()).toBe(true);
    expect(second.calls[0]?.form).toMatchObject({ client_id: DEV, code: "c2" });

    const rows = await db.select().from(appleToken).where(eq(appleToken.userId, rider.userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.clientId).toBe(DEV);
    expect(rows[0]?.refreshToken).not.toContain("r-dev");

    const stranger = fakeApple("r-x");
    expect((await rememberAppleToken(db, settings, { userId: rider.userId, idToken: identityToken("com.someone.else"), authorizationCode: "c3" }, stranger.fetcher)).isErr()).toBe(true);
    expect(stranger.calls).toEqual([]);
  });

  test("revoking decrypts the token and revokes it for the same app", async () => {
    const apple = fakeApple("unused");
    expect((await revokeAppleToken(db, settings, rider.userId, apple.fetcher))._unsafeUnwrap()).toBe("revoked");
    expect(apple.calls[0]).toMatchObject({ url: "https://appleid.apple.com/auth/revoke", form: { client_id: DEV, token: "r-dev", token_type_hint: "refresh_token" } });
    expect((await revokeAppleToken(db, settings, "nobody", apple.fetcher))._unsafeUnwrap()).toBe("none");
  });

  test("deleting the account revokes Apple's token first, and deletes even when Apple fails", async () => {
    const revoked: Record<string, string>[] = [];
    let appleStatus = 200;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith("https://appleid.apple.com/")) return realFetch(input, init);
      revoked.push(Object.fromEntries(new URLSearchParams(String(init?.body))));
      return new Response("{}", { status: appleStatus });
    }) as typeof fetch;
    const { key } = await testSigningKey();
    const appleBindings = { APPLE_TEAM_ID: key.teamId, APPLE_SIGN_IN_KEY_ID: key.keyId, APPLE_SIGN_IN_KEY: key.privateKey };

    const deleted = await call("/v1/me", { method: "DELETE", headers: rider.bearer }, appleBindings);
    expect(deleted.status).toBe(200);
    expect(revoked).toEqual([expect.objectContaining({ client_id: DEV, token: "r-dev" })]);
    expect(await db.select().from(user).where(eq(user.id, rider.userId))).toEqual([]);
    expect(await db.select().from(appleToken).where(eq(appleToken.userId, rider.userId))).toEqual([]);

    const other = await createRider(db, "Apple Rider Two");
    await rememberAppleToken(db, settings, { userId: other.userId, idToken: identityToken(RELEASE), authorizationCode: "c4" }, fakeApple("r-two").fetcher);
    appleStatus = 500;
    expect((await call("/v1/me", { method: "DELETE", headers: other.bearer }, appleBindings)).status).toBe(200);
    expect(await db.select().from(user).where(eq(user.id, other.userId))).toEqual([]);
  });
});
