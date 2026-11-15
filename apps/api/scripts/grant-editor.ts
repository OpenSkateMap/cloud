import { parseArgs } from "node:util";
import { openDatabase, schema } from "@openskatemap/db";
import { and, eq } from "drizzle-orm";

const { positionals, values } = parseArgs({ allowPositionals: true, options: { revoke: { type: "boolean", default: false } } });
const [userId, slug] = positionals;
const url = process.env.DATABASE_URL;
if (!url || !userId || !slug || positionals.length !== 2) {
  console.error("Usage: DATABASE_URL=... bun run grant-editor <user-id> <city-slug> [--revoke]");
  process.exit(2);
}

const database = await openDatabase(url);
try {
  const message = await database.db.transaction(async (tx) => {
    const [city] = await tx.select({ id: schema.city.id, name: schema.city.name }).from(schema.city).where(eq(schema.city.slug, slug));
    const [account] = await tx.select({ id: schema.user.id, role: schema.user.role }).from(schema.user).where(eq(schema.user.id, userId));
    if (!city) return { ok: false, text: `No city with slug ${slug}` };
    if (!account) return { ok: false, text: `No account ${userId}` };
    if (!values.revoke) {
      await tx.insert(schema.cityEditor).values({ cityId: city.id, userId }).onConflictDoNothing();
      if (account.role === "user") await tx.update(schema.user).set({ role: "editor", updatedAt: new Date() }).where(eq(schema.user.id, userId));
      return { ok: true, text: `${userId} now reviews ${city.name}` };
    }
    await tx.delete(schema.cityEditor).where(and(eq(schema.cityEditor.cityId, city.id), eq(schema.cityEditor.userId, userId)));
    const remaining = await tx.select({ cityId: schema.cityEditor.cityId }).from(schema.cityEditor).where(eq(schema.cityEditor.userId, userId));
    if (remaining.length === 0 && account.role === "editor") {
      await tx.update(schema.user).set({ role: "user", updatedAt: new Date() }).where(eq(schema.user.id, userId));
    }
    return { ok: true, text: `${userId} no longer reviews ${city.name}` };
  });
  (message.ok ? console.log : console.error)(message.text);
  process.exitCode = message.ok ? 0 : 1;
} finally {
  await database.close();
}
