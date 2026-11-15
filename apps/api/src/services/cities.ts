import type { Database } from "@openskatemap/db";
import { city } from "@openskatemap/db/schema";
import { sql } from "drizzle-orm";

export interface CityInput {
  readonly slug: string;
  readonly name: string;
  readonly countryCode: string;
  readonly bbox: readonly [number, number, number, number];
}

export function saveCity(db: Database, { slug, name, countryCode, bbox: [west, south, east, north] }: CityInput) {
  const area = sql`ST_Multi(ST_MakeEnvelope(${west}, ${south}, ${east}, ${north}, 4326))`;
  return db.transaction(async (tx) => {
    await tx
      .insert(city)
      .values({ id: crypto.randomUUID(), slug, name, countryCode, area })
      .onConflictDoUpdate({ target: city.slug, set: { name, countryCode, area } });
    const moved = await tx.execute(sql`
      update spot set city_id = spot_city_for(location) where city_id is distinct from spot_city_for(location)
    `);
    await tx.execute(sql`
      update submission set city_id = spot_city_for(location)
      where status = 'pending' and city_id is distinct from spot_city_for(location)
    `);
    return moved.rowCount ?? 0;
  });
}
