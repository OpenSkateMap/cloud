import { openDatabase, schema } from "@openskatemap/db";
import { and, eq, isNull } from "drizzle-orm";
import { livePlaceLookup } from "../src/lib/nominatim.ts";
import { fileSpot } from "../src/services/city-places.ts";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Usage: DATABASE_URL=... bun run file-cityless-spots");
  process.exit(2);
}

const { spot } = schema;
const database = await openDatabase(url);
try {
  const { db } = database;
  const spots = await db
    .select({ id: spot.id, title: spot.title })
    .from(spot)
    .where(and(isNull(spot.cityId), eq(spot.status, "published"), eq(spot.visibility, "public")));
  console.log(`${spots.length} published public spot(s) outside every city`);
  for (const { id, title } of spots) {
    const filed = await fileSpot(db, livePlaceLookup, id);
    const outcome = filed.match(
      (value) => (value.kind === "filed" ? `${value.created ? "new city" : "city"} ${value.cityId}` : "nothing to do"),
      (failure) => `left outside: ${JSON.stringify(failure)}`,
    );
    console.log(`${id} ${title}: ${outcome}`);
  }
} finally {
  await database.close();
}
