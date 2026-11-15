import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../env.ts";
import { respondError } from "./respond.ts";

export function createRouter() {
  return new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (result.success) return;
      return respondError(c, {
        code: "validation_failed",
        message: "The request did not pass validation",
        details: {
          issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        },
      });
    },
  });
}
