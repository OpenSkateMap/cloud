import { describe, expect, test } from "bun:test";
import { createApp, openApiInfo } from "../src/app.ts";
import { PUBLIC_OPERATIONS } from "../src/lib/public-operations.ts";
import { bindings, executionContext } from "./support.ts";

const app = createApp();
const spec = app.getOpenAPI31Document(openApiInfo);
const methods = ["get", "put", "post", "delete", "patch", "head", "options"] as const;

const operations = Object.entries(spec.paths ?? {}).flatMap(([path, item]) =>
  methods.flatMap((method) => {
    const operation = item?.[method];
    return operation ? [{ path, method, operation }] : [];
  }),
);
const guarded = operations.filter(({ operation }) => !PUBLIC_OPERATIONS.has(operation.operationId ?? ""));

describe("deny by default", () => {
  test("every operation has an operationId", () => {
    expect(operations.filter(({ operation }) => !operation.operationId)).toEqual([]);
  });

  test("every operation is public by decision or requires a bearer token", () => {
    const unguarded = guarded.filter(
      ({ operation }) => !(operation.security ?? spec.security ?? []).some((requirement) => "bearerAuth" in requirement),
    );
    expect(unguarded.map(({ method, path }) => `${method.toUpperCase()} ${path}`)).toEqual([]);
  });

  test("the public list names only operations that exist", () => {
    const ids = new Set(operations.map(({ operation }) => operation.operationId));
    expect([...PUBLIC_OPERATIONS].filter((id) => !ids.has(id))).toEqual([]);
  });

  test("every guarded operation refuses a request without a token, before touching the database", async () => {
    const answers = await Promise.all(
      guarded.map(async ({ path, method }) => {
        const url = path.replace(/\{[^}]+\}/g, "x");
        const response = await app.request(url, { method: method.toUpperCase() }, bindings(), executionContext().ctx);
        const body = (await response.json()) as { error?: { code?: string } };
        return `${method.toUpperCase()} ${path} -> ${response.status} ${body.error?.code}`;
      }),
    );
    expect(answers).toEqual(guarded.map(({ path, method }) => `${method.toUpperCase()} ${path} -> 401 auth_required`));
  });
});
