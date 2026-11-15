import { describe, expect, test } from "bun:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { verifyAppleNotification } from "../src/auth/apple-notifications.ts";

const audience = ["com.ertembiyik.openskatemap", "com.ertembiyik.openskatemap.dev"];
const apple = await generateKeyPair("RS256");
const stranger = await generateKeyPair("RS256");
const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(apple.publicKey)), kid: "apple", alg: "RS256" }] });

const notice = (events: unknown, { key = apple.privateKey, iss = "https://appleid.apple.com", aud = audience[0]! } = {}) =>
  new SignJWT({ events })
    .setProtectedHeader({ alg: "RS256", kid: "apple" })
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt()
    .sign(key);

describe("Apple's account notices", () => {
  test("a signed notice gives its event, with Apple's example shape", async () => {
    const event = await verifyAppleNotification(await notice({ type: "consent-revoked", sub: "000123.abc.0219", event_time: 1508184845 }), audience, keys);
    expect(event._unsafeUnwrap()).toEqual({ type: "consent-revoked", appleUserId: "000123.abc.0219", at: new Date(1508184845000) });
  });

  test("events as a JSON string and the time in milliseconds read the same", async () => {
    const events = JSON.stringify({ type: "account-delete", sub: "000123.abc.0219", event_time: 1508184845123 });
    const event = await verifyAppleNotification(await notice(events, { aud: audience[1]! }), audience, keys);
    expect(event._unsafeUnwrap()).toEqual({ type: "account-delete", appleUserId: "000123.abc.0219", at: new Date(1508184845123) });
  });

  test("anything not signed by Apple's key, for our apps, from Apple, is refused", async () => {
    const events = { type: "consent-revoked", sub: "000123.abc.0219", event_time: 1508184845 };
    for (const forged of [
      await notice(events, { key: stranger.privateKey }),
      await notice(events, { aud: "com.example.other" }),
      await notice(events, { iss: "https://example.com" }),
      "not-a-jwt",
    ]) {
      expect((await verifyAppleNotification(forged, audience, keys)).isErr()).toBe(true);
    }
  });

  test("a notice without a readable event is refused", async () => {
    expect((await verifyAppleNotification(await notice("{not json"), audience, keys)).isErr()).toBe(true);
    expect((await verifyAppleNotification(await notice({ type: "consent-revoked" }), audience, keys)).isErr()).toBe(true);
  });
});
