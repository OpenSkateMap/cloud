import { describe, expect, test } from "bun:test";
import { appleClientSecret, exchangeAuthorizationCode, identityTokenAudience, revokeRefreshToken } from "../src/auth/apple-tokens.ts";
import { testSigningKey } from "./support.ts";

const decode = (part: string) => JSON.parse(atob(part.replaceAll("-", "+").replaceAll("_", "/")));
const bytes = (part: string) => Uint8Array.from(atob(part.replaceAll("-", "+").replaceAll("_", "/")), (character) => character.charCodeAt(0));

function fakeApple(status: number, body: unknown) {
  const calls: { url: string; form: URLSearchParams }[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    calls.push({ url, form: new URLSearchParams(String(init?.body)) });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { calls, fetcher };
}

describe("Apple tokens", () => {
  test("the client secret is an ES256 JWT for one client, verifiable with the key's public half", async () => {
    const { key, publicKey } = await testSigningKey();
    const secret = await appleClientSecret(key, "com.ertembiyik.openskatemap", 1_791_000_000_000);
    const [header = "", payload = "", signature = ""] = secret.split(".");
    expect(decode(header)).toEqual({ alg: "ES256", kid: "KEYID12345", typ: "JWT" });
    expect(decode(payload)).toEqual({ iss: "TEAMID1234", iat: 1_791_000_000, exp: 1_791_000_300, aud: "https://appleid.apple.com", sub: "com.ertembiyik.openskatemap" });
    const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, bytes(signature), new TextEncoder().encode(`${header}.${payload}`));
    expect(valid).toBe(true);
  });

  test("a code is exchanged for the refresh token, with this client's secret", async () => {
    const { key } = await testSigningKey();
    const apple = fakeApple(200, { access_token: "a", refresh_token: "r-123", id_token: "i" });
    expect((await exchangeAuthorizationCode(key, "com.ertembiyik.openskatemap.dev", "code-1", apple.fetcher))._unsafeUnwrap()).toBe("r-123");
    expect(apple.calls[0]?.url).toBe("https://appleid.apple.com/auth/token");
    const form = Object.fromEntries(apple.calls[0]!.form);
    expect(form).toMatchObject({ client_id: "com.ertembiyik.openskatemap.dev", code: "code-1", grant_type: "authorization_code" });
    expect(decode(form.client_secret!.split(".")[1]!).sub).toBe("com.ertembiyik.openskatemap.dev");

    expect((await exchangeAuthorizationCode(key, "x", "used-code", fakeApple(400, { error: "invalid_grant" }).fetcher))._unsafeUnwrapErr()).toContain("400");
    expect((await exchangeAuthorizationCode(key, "x", "code", fakeApple(200, { access_token: "a" }).fetcher)).isErr()).toBe(true);
  });

  test("a refresh token is revoked as a refresh token", async () => {
    const { key } = await testSigningKey();
    const apple = fakeApple(200, {});
    expect((await revokeRefreshToken(key, "com.ertembiyik.openskatemap", "r-123", apple.fetcher)).isOk()).toBe(true);
    expect(apple.calls[0]?.url).toBe("https://appleid.apple.com/auth/revoke");
    expect(Object.fromEntries(apple.calls[0]!.form)).toMatchObject({ client_id: "com.ertembiyik.openskatemap", token: "r-123", token_type_hint: "refresh_token" });
    expect((await revokeRefreshToken(key, "x", "r", fakeApple(400, {}).fetcher)).isErr()).toBe(true);
  });

  test("the identity token's audience names the app that signed in", () => {
    const token = (claims: unknown) => `h.${btoa(JSON.stringify(claims)).replaceAll("=", "")}.s`;
    expect(identityTokenAudience(token({ aud: "com.ertembiyik.openskatemap" }))).toBe("com.ertembiyik.openskatemap");
    expect(identityTokenAudience(token({ aud: ["com.ertembiyik.openskatemap.dev"] }))).toBe("com.ertembiyik.openskatemap.dev");
    expect(identityTokenAudience("not-a-jwt")).toBeUndefined();
    expect(identityTokenAudience("h.%%%.s")).toBeUndefined();
  });
});
