import { describe, expect, test } from "bun:test";
import { capture, captureToken, deletePerson, eventUuid, located, parsePersonsSettings } from "../src/lib/posthog.ts";

function stub(status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(null, { status });
  }) as typeof fetch;
  return { fetcher, calls };
}

describe("analytics", () => {
  test("a request is tracked only with a project token and without DNT: 1", () => {
    const env = { POSTHOG_PROJECT_TOKEN: "phc_test" };
    expect(captureToken(env, new Headers())).toBe("phc_test");
    expect(captureToken(env, new Headers({ DNT: "1" }))).toBeUndefined();
    expect(captureToken({}, new Headers())).toBeUndefined();
    expect(captureToken({ POSTHOG_PROJECT_TOKEN: "phx_personal" }, new Headers())).toBeUndefined();
  });

  test("an event goes to the project under the account id", async () => {
    const { fetcher, calls } = stub();
    await capture("phc_test", "spot_voted", "user-1", { value: 1 }, undefined, fetcher);
    expect(calls[0]?.url).toBe("https://us.i.posthog.com/i/v0/e/");
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body).toMatchObject({
      api_key: "phc_test",
      event: "spot_voted",
      distinct_id: "user-1",
      properties: { value: 1, $lib: "openskatemap-api" },
    });
    expect(body.uuid).toBeUndefined();
  });

  test("the area is looked up from the caller's address, never from the Worker's", () => {
    expect(located(new Headers({ "CF-Connecting-IP": "203.0.113.7" }))).toEqual({ $ip: "203.0.113.7" });
    expect(located(new Headers())).toEqual({ $geoip_disable: true });
  });

  test("a business event keeps one UUID across retries, and a different one per event", async () => {
    const { fetcher, calls } = stub();
    await capture("phc_test", "spot_submitted", "user-1", {}, "sub-1", fetcher);
    await capture("phc_test", "spot_submitted", "user-1", {}, "sub-1", fetcher);
    const [first, second] = calls.map((call) => JSON.parse(String(call.init.body)).uuid);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await eventUuid("edit_suggested:sub-1")).not.toBe(first);
  });

  test("deleting is off unless a project id and a personal key are both set", () => {
    const env = { POSTHOG_PROJECT_ID: "12345", POSTHOG_PERSONAL_API_KEY: "phx_test" };
    expect(parsePersonsSettings(env)).toEqual({ projectId: "12345", apiKey: "phx_test" });
    expect(parsePersonsSettings({ ...env, POSTHOG_PROJECT_ID: undefined })).toBeUndefined();
    expect(parsePersonsSettings({ ...env, POSTHOG_PERSONAL_API_KEY: "phc_project_token" })).toBeUndefined();
  });

  test("a deleted account's person and events are deleted by its distinct id", async () => {
    const { fetcher, calls } = stub(202);
    await deletePerson({ projectId: "12345", apiKey: "phx_test" }, "user-1", fetcher);
    expect(calls[0]?.url).toBe("https://us.posthog.com/api/projects/12345/persons/bulk_delete/");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer phx_test");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ distinct_ids: ["user-1"], delete_events: true });
  });

  test("failures are logged, never thrown into the request", async () => {
    const fetcher = (async (_url: URL | RequestInfo, _init?: RequestInit): Promise<Response> => {
      throw new Error("offline");
    }) as typeof fetch;
    await expect(capture("phc_test", "spot_voted", "user-1", {}, undefined, fetcher)).resolves.toBeUndefined();
    await expect(deletePerson({ projectId: "1", apiKey: "phx_test" }, "user-1", fetcher)).resolves.toBeUndefined();
  });
});
