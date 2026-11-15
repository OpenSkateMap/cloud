import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { bindings, executionContext, limiter } from "./support.ts";

const app = createApp();
const get = (path: string, env = bindings()) => app.request(path, {}, env, executionContext().ctx);

describe("envelope", () => {
  test("an unknown path is a typed not_found error", async () => {
    const response = await get("/v1/nope");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "not_found", retryable: false } });
  });

  test("health reports a database that does not answer as a retryable 503", async () => {
    const response = await get("/v1/health");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "unavailable", retryable: true } });
  });

  test("a client over the address limit is told to wait, before any database work", async () => {
    const response = await get("/v1/health", bindings({ API_LIMITER: limiter(false) }));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "rate_limited", retryable: true } });
  });

  test("the address flood guard stops signed-in requests too, before any database work", async () => {
    const response = await app.request("/v1/me", { headers: { authorization: "Bearer token" } }, bindings({ ADDRESS_LIMITER: limiter(false) }), executionContext().ctx);
    expect(response.status).toBe(429);
  });

  test("a signed-in operation doesn't spend its address's API budget", async () => {
    const response = await app.request("/v1/me", { headers: { authorization: "Bearer token" } }, bindings({ API_LIMITER: limiter(false) }), executionContext().ctx);
    expect(response.status).toBe(503);
  });

  test("a public operation spends its address's budget even with a token", async () => {
    const response = await app.request("/v1/health", { headers: { authorization: "Bearer token" } }, bindings({ API_LIMITER: limiter(false) }), executionContext().ctx);
    expect(response.status).toBe(429);
  });

  test("API responses carry the security headers", async () => {
    const response = await get("/v1/nope");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});

describe("openapi", () => {
  test("error codes are one named schema, so clients get a single enum", async () => {
    const response = await get("/v1/openapi.json");
    const spec = (await response.json()) as { components: { schemas: Record<string, { enum?: string[] }> } };
    expect(spec.components.schemas.ErrorCode?.enum).toContain("unavailable");
    expect(spec.components.schemas.ErrorEnvelope).toBeDefined();
  });
});
