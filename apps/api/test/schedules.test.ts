import { describe, expect, test } from "bun:test";
import { SCHEDULES } from "../src/schedules.ts";

describe("cron triggers", () => {
  test("the config schedules exactly what the Worker tells apart", async () => {
    const config = await Bun.file(new URL("../cloudflare.config.ts", import.meta.url)).text();
    const listed = [...config.matchAll(/triggers: \[([^\]]*)\]/g)].flatMap((match) => [...(match[1] ?? "").matchAll(/"([^"]+)"/g)].map((cron) => cron[1]));
    expect(listed.sort()).toEqual(Object.values(SCHEDULES).sort());
  });
});
