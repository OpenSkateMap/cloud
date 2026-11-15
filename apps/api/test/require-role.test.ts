import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Role } from "../src/auth/roles.ts";
import type { AppEnv } from "../src/env.ts";
import { requireRole } from "../src/middleware/require-role.ts";

function editorOnly(role: Role) {
  return new Hono<AppEnv>()
    .use(async (c, next) => {
      c.set("user", { id: "u1", name: "Rider", email: "r@example.com", role, createdAt: new Date(0) });
      await next();
    })
    .get("/review", requireRole("editor"), (c) => c.text("ok"));
}

describe("requireRole", () => {
  test("a plain user is refused with a typed 403", async () => {
    const response = await editorOnly("user").request("/review");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  test("the named role passes", async () => {
    expect((await editorOnly("editor").request("/review")).status).toBe(200);
  });

  test("admins pass everywhere", async () => {
    expect((await editorOnly("admin").request("/review")).status).toBe(200);
  });
});
