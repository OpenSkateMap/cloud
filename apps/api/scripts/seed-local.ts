import { openDatabase, schema } from "@openskatemap/db";
import { sql } from "drizzle-orm";
import { type CityInput, saveCity } from "../src/services/cities.ts";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://openskatemap_app:openskatemap_app@localhost:54330/openskatemap";
const host = new URL(databaseUrl).hostname;
if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing to seed a non-local database: ${host}`);

const CITIES: CityInput[] = [
  { slug: "london", name: "London", countryCode: "GB", bbox: [-0.51, 51.28, 0.33, 51.69] },
  { slug: "barcelona", name: "Barcelona", countryCode: "ES", bbox: [2.05, 41.32, 2.23, 41.47] },
];

type Spot = typeof schema.spot.$inferInsert;
const SPOTS: Spot[] = [
  { id: "seed-southbank", title: "Southbank Undercroft", kind: "plaza", location: { latitude: 51.5066, longitude: -0.1169 }, obstacles: ["ledges", "banks", "stairs"], description: "The birthplace of British street skating, under the Queen Elizabeth Hall." },
  { id: "seed-house-of-vans", title: "House of Vans London", kind: "park", location: { latitude: 51.5013, longitude: -0.1153 }, obstacles: ["bowl", "mini ramp", "street course"] },
  { id: "seed-baysixty6", title: "BaySixty6", kind: "park", location: { latitude: 51.5193, longitude: -0.209 }, obstacles: ["vert ramp", "mini ramp", "street course"] },
  { id: "seed-stockwell", title: "Stockwell Skatepark", kind: "park", location: { latitude: 51.471, longitude: -0.1163 }, obstacles: ["bowl", "banks"], description: "Brixton Beach: concrete since 1978." },
  { id: "seed-mile-end", title: "Mile End Skatepark", kind: "park", location: { latitude: 51.518, longitude: -0.034 }, obstacles: ["ledges", "rails", "manual pads"] },
  { id: "seed-macba", title: "MACBA", kind: "plaza", location: { latitude: 41.383, longitude: 2.1665 }, obstacles: ["ledges", "gap", "banks"], description: "The plaza in front of the museum: marble ledges, the four-stair gap and the long bank." },
  { id: "seed-sants", title: "Sants", kind: "plaza", location: { latitude: 41.379, longitude: 2.1405 }, obstacles: ["ledges", "benches"] },
  { id: "seed-forum", title: "Fòrum", kind: "plaza", location: { latitude: 41.411, longitude: 2.221 }, obstacles: ["ledges", "gaps", "banks"] },
  { id: "seed-coromines", title: "Plaça Joan Coromines", kind: "plaza", location: { latitude: 41.3838, longitude: 2.1679 }, obstacles: ["ledges", "manual pads"] },
  { id: "seed-universitat", title: "Universitat", kind: "street", location: { latitude: 41.3868, longitude: 2.1637 }, obstacles: ["ledges", "benches"] },
  { id: "seed-correos", title: "Correos", kind: "plaza", location: { latitude: 41.3815, longitude: 2.1815 }, obstacles: ["ledges", "banks"] },
  { id: "seed-arc", title: "Arc de Triomf", kind: "plaza", location: { latitude: 41.3912, longitude: 2.1808 }, obstacles: ["ledges", "flatground"] },
  { id: "seed-estacio-nord", title: "Estació del Nord", kind: "street", location: { latitude: 41.3948, longitude: 2.1836 }, obstacles: ["banks", "hips"] },
  { id: "seed-parallel", title: "Paral·lel", kind: "street", location: { latitude: 41.3746, longitude: 2.1652 }, obstacles: ["benches", "ledges"] },
  { id: "seed-glories", title: "Glòries", kind: "plaza", location: { latitude: 41.4035, longitude: 2.1872 }, obstacles: ["ledges", "stairs"] },
  { id: "seed-sol", title: "Plaça del Sol", kind: "plaza", location: { latitude: 41.4011, longitude: 2.1568 }, obstacles: ["benches", "flatground"] },
  { id: "seed-mar-bella", title: "Mar Bella Skatepark", kind: "park", location: { latitude: 41.3997, longitude: 2.2104 }, obstacles: ["bowl", "street course"] },
  { id: "seed-font-magica", title: "Font Màgica Stairs", kind: "street", location: { latitude: 41.3713, longitude: 2.1517 }, obstacles: ["stairs", "rails"] },
  { id: "seed-poblenou-diy", title: "Poblenou DIY", kind: "diy", location: { latitude: 41.4025, longitude: 2.1985 }, obstacles: ["quarter pipe", "ledges"] },
  { id: "seed-clot", title: "Parc del Clot", kind: "street", location: { latitude: 41.4095, longitude: 2.1883 }, obstacles: ["banks", "ledges"] },
  { id: "seed-sants-park", title: "Sants Skatepark", kind: "park", location: { latitude: 41.3755, longitude: 2.1335 }, obstacles: ["mini ramp", "street course"] },
];

const database = await openDatabase(databaseUrl);
try {
  const { db } = database;
  for (const input of CITIES) await saveCity(db, input);
  for (const row of SPOTS) {
    const { id: _, ...changes } = row;
    await db.insert(schema.spot).values(row).onConflictDoUpdate({ target: schema.spot.id, set: { ...changes, status: "published" } });
  }

  const now = new Date();
  const rider = { id: "seed-rider", name: "Local Rider", email: "rider@localhost", role: "admin", emailVerified: true, createdAt: now, updatedAt: now };
  await db.insert(schema.user).values(rider).onConflictDoUpdate({ target: schema.user.id, set: { name: rider.name, role: rider.role, updatedAt: now } });
  const token = crypto.randomUUID().replaceAll("-", "");
  await db.delete(schema.session).where(sql`${schema.session.userId} = ${rider.id}`);
  await db.insert(schema.session).values({ id: `seed-${token.slice(0, 8)}`, token, userId: rider.id, expiresAt: new Date(now.getTime() + 30 * 86_400_000), createdAt: now, updatedAt: now });

  console.log(`Seeded ${CITIES.length} cities and ${SPOTS.length} spots.`);
  console.log(`Local Rider (admin) token, valid 30 days: ${token}`);
} finally {
  await database.close();
}
