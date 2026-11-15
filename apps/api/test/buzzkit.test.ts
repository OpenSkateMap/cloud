import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { type PushMessage, type PushSettings, parsePushSettings, retryAfterMs, sendPush, sendPushes, signPushIdentity } from "../src/lib/buzzkit.ts";
import { listed } from "../src/services/notifications.ts";

const settings: PushSettings = { apiUrl: "https://push.test", apiKey: "bk_ws_test", identitySecret: "s3cret-identity-secret" };
const message: PushMessage = {
  audience: { to: ["user-1"] },
  topic: "review-results",
  title: "MACBA is on the map",
  body: "A curator approved it",
  destination: { deepLink: "https://openskatemap.app/spots/s1" },
  idempotencyKey: "review-result-x",
};

function stub(statuses: number[], headers: HeadersInit = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const status = statuses[calls.length - 1] ?? 202;
    const body = status < 300 ? { success: true, error: null } : { success: false, error: { code: status === 409 ? "idempotency_key_reused" : "bad" } };
    return new Response(JSON.stringify(body), { status, headers });
  }) as typeof fetch;
  return { fetcher, calls };
}

describe("push", () => {
  test("the identity hash is BuzzKit's: HMAC-SHA256 of the user id under the identity secret, hex", async () => {
    const expected = createHmac("sha256", settings.identitySecret).update("user-1").digest("hex");
    expect(await signPushIdentity("user-1", settings.identitySecret)).toBe(expected);
  });

  test("push is off unless the URL, a workspace key and the identity secret are all set", () => {
    const env = { BUZZKIT_API_URL: "https://push.test", BUZZKIT_API_KEY: "bk_ws_x", BUZZKIT_IDENTITY_SECRET: "0123456789abcdef" };
    expect(parsePushSettings(env)?.apiKey).toBe("bk_ws_x");
    expect(parsePushSettings({ ...env, BUZZKIT_API_KEY: undefined })).toBeUndefined();
    expect(parsePushSettings({ ...env, BUZZKIT_API_KEY: "bk_pk_client" })).toBeUndefined();
  });

  test("a batch sends every message, at most four at a time", async () => {
    let open = 0;
    let most = 0;
    const keys: string[] = [];
    const fetcher = (async (_url: URL | RequestInfo, init?: RequestInit) => {
      open += 1;
      most = Math.max(most, open);
      keys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
      await Bun.sleep(1);
      open -= 1;
      return new Response(JSON.stringify({ success: true, error: null }), { status: 202 });
    }) as typeof fetch;
    const batch = Array.from({ length: 10 }, (_, index) => ({ ...message, idempotencyKey: `key-${index}` }));
    await sendPushes(settings, batch, fetcher);
    expect(keys.toSorted()).toEqual(batch.map((item) => item.idempotencyKey).toSorted());
    expect(most).toBe(4);
  });

  test("a send posts the message under its idempotency key, with the destination at the top level", async () => {
    const { fetcher, calls } = stub([202]);
    await sendPush(settings, message, fetcher);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://push.test/v1/messages");
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer bk_ws_test");
    expect(headers.get("idempotency-key")).toBe("review-result-x");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      to: ["user-1"],
      topic: "review-results",
      title: "MACBA is on the map",
      body: "A curator approved it",
      deepLink: "https://openskatemap.app/spots/s1",
    });
  });

  test("a 5xx is retried once; a 4xx is not; nobody to tell sends nothing", async () => {
    const flaky = stub([503, 202]);
    await sendPush(settings, message, flaky.fetcher);
    expect(flaky.calls).toHaveLength(2);

    const refused = stub([409]);
    await sendPush(settings, message, refused.fetcher);
    expect(refused.calls).toHaveLength(1);

    const nobody = stub([]);
    await sendPush(settings, { ...message, audience: { to: [] } }, nobody.fetcher);
    expect(nobody.calls).toHaveLength(0);
  });

  test("a 429 waits as long as Retry-After says, unless that's longer than the send can wait", async () => {
    const soon = stub([429, 202], { "retry-after": "0" });
    await sendPush(settings, message, soon.fetcher);
    expect(soon.calls).toHaveLength(2);

    const later = stub([429, 202], { "retry-after": "3600" });
    await sendPush(settings, message, later.fetcher);
    expect(later.calls).toHaveLength(1);

    expect(retryAfterMs("2")).toBe(2000);
    expect(retryAfterMs(new Date(10_000).toUTCString(), 4000)).toBe(6000);
    expect(retryAfterMs("soon")).toBeUndefined();
    expect(retryAfterMs(null)).toBeUndefined();
  });

  test("the digest names spots as a sentence would", () => {
    expect(listed(["MACBA"])).toBe("MACBA");
    expect(listed(["MACBA", "Fòrum"])).toBe("MACBA and Fòrum");
    expect(listed(["MACBA", "Fòrum", "Sants"])).toBe("MACBA, Fòrum and Sants");
  });
});
