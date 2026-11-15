import type { Database } from "@openskatemap/db";
import { createAuth } from "./create-auth.ts";

export const auth = createAuth({} as Database, {
  apiOrigin: "http://localhost:8787",
  secret: "schema-generation-only-not-a-real-secret",
  appleBundleIds: ["com.example.unused"],
});
