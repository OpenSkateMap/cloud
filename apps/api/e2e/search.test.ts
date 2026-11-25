import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "@hono/zod-openapi";
import { type Database, openDatabase, schema } from "@openskatemap/db";
import { eq, sql } from "drizzle-orm";
import { SpotIndexRowSchema, SyncPageSchema } from "../src/lib/spot-schemas.ts";
import { call, createRider, e2eUrl, read } from "./support.ts";

const { city, spot, user } = schema;

describe.skipIf(!e2eUrl)("spot search (database)", () => {
  const database = e2eUrl ? openDatabase(e2eUrl) : undefined;
  const tag = crypto.randomUUID().slice(0, 8);
  const prefix = `e2e-${tag}-`;
  const id = (name: string) => `${prefix}${name}`;
  const cityId = `e2e-city-${tag}`;
  const nearPier = { latitude: 59.95, longitude: 30.3 };
  const nearBay = { latitude: 59.8, longitude: 30.1 };
  let db: Database;
  let rider: Awaited<ReturnType<typeof createRider>>;

  const SearchSchema = z.object({ spots: z.array(SpotIndexRowSchema) });
  const search = (q: string, extra: Record<string, string | number> = {}) => {
    const params = new URLSearchParams({ q });
    for (const [key, value] of Object.entries(extra)) params.set(key, String(value));
    return read(SearchSchema, `/v1/spots/search?${params}`, { headers: rider.bearer });
  };
  // Other suites' spots may share the table; only this run's are compared.
  const found = async (q: string, extra: Record<string, string | number> = {}) =>
    (await search(q, extra)).spots.map((row) => row.id).filter((spotId) => spotId.startsWith(prefix));

  beforeAll(async () => {
    db = (await database!).db;
    rider = await createRider(db, "Search Rider");
    await db.insert(city).values({
      id: cityId,
      slug: `e2e-${tag}`,
      name: "Zelenogorsk",
      names: { en: "Zelenogorsk", ru: "Зеленогорск", ja: "ゼレノゴルスク" },
      countryCode: "RU",
      area: sql`ST_Multi(ST_MakeEnvelope(29.6, 60.15, 29.8, 60.25, 4326))`,
    });
    await db.insert(spot).values([
      { id: id("novo"), title: "Новокрестовская", kind: "plaza", location: { latitude: 59.971, longitude: 30.26 } },
      { id: id("krest"), title: "Крестовская набережная", kind: "street", location: { latitude: 59.972, longitude: 30.265 } },
      { id: id("secret"), title: "Новокрестовская тайная", kind: "street", visibility: "private", location: { latitude: 59.973, longitude: 30.26 } },
      { id: id("gone"), title: "Новокрестовская старая", kind: "street", status: "removed", location: { latitude: 59.974, longitude: 30.26 } },
      { id: id("elka"), title: "Ёлочный парапет", kind: "street", location: { latitude: 59.94, longitude: 30.31 } },
      { id: id("bereza"), title: "Березовая горка", kind: "diy", location: { latitude: 59.93, longitude: 30.32 } },
      { id: id("may"), title: "Майская плаза", kind: "plaza", location: { latitude: 59.92, longitude: 30.33 } },
      { id: id("mirror-a"), title: "Зеркальный борт", kind: "street", location: nearPier },
      { id: id("mirror-b"), title: "Зеркальный борт", kind: "street", location: nearBay },
      { id: id("zaliv"), title: "Борт у залива", kind: "street", location: { latitude: 60.2, longitude: 29.7 } },
    ]);
  });

  afterAll(async () => {
    await db.delete(spot).where(sql`${spot.id} like ${`${prefix}%`}`);
    await db.delete(city).where(eq(city.id, cityId));
    await db.delete(user).where(eq(user.id, rider.userId));
    await (await database!).close();
  });

  test("search text: Latin letters (Cyrillic romanised, й as both i and y), lowercase, no accents", async () => {
    const cases: [string, string][] = [
      ["Новокрестовская", "novokrestovskaya"],
      ["Ёлочный Парапет", "elochnyi parapet elochnyy parapet"],
      ["Щука, Жук & Чайка!", "shchuka zhuk chaika shchuka zhuk chayka"],
      ["Объезд Цирка Хохлома Юла Яма Мышь", "obezd tsirka khokhloma yula yama mysh"],
      ["Київ Євпаторія Ґанок", "kiyiv yevpatoriya ganok"],
      ["Plaça del Sol", "placa del sol"],
      ["Café Ñandú", "cafe nandu"],
      ["Straße №5", "strasse no5"],
      ["  !!  ", ""],
    ];
    const words = [];
    for (const [title] of cases) words.push((await db.execute<{ words: string }>(sql`select search_words(${title}) as words`)).rows[0]?.words);
    expect(words).toEqual(cases.map(([, expected]) => expected));
  });

  test("a lowercase Cyrillic query finds a capitalised Cyrillic title", async () => {
    expect((await found("новокрестовская"))[0]).toBe(id("novo"));
    expect(await found("НОВОКРЕСТОВСКАЯ")).toContain(id("novo"));
  });

  test("every word starts a word of the title; a word inside one ranks lower", async () => {
    expect(await found("ново")).toContain(id("novo"));
    expect(await found("наб крест")).toEqual([id("krest")]);
    expect(await found("крестовская")).toEqual([id("krest"), id("novo")]);
  });

  test("the Latin spelling finds a Cyrillic title", async () => {
    expect(await found("novokrestovskaya")).toEqual([id("novo")]);
    expect(await found("novokrest")).toEqual([id("novo")]);
    expect(await found("Krestovskaya Naberezhnaya")).toEqual([id("krest")]);
  });

  test("ё is е and й is и, either way round", async () => {
    expect(await found("елочный")).toEqual([id("elka")]);
    expect(await found("берёзовая")).toEqual([id("bereza")]);
    expect(await found("маиская")).toEqual([id("may")]);
  });

  test("a word with a wrong letter still finds the spot, after the exact matches", async () => {
    expect(await found("новокристовская")).toEqual([id("novo")]);
    expect(await found("novokrestovskya")).toEqual([id("novo")]);
    expect(await found("novokristovsk")).toEqual([id("novo")]);
    expect(await found("крестовскоя")).toEqual([id("krest")]);
    // Four letters allow no typos.
    expect(await found("борк")).toEqual([]);
  });

  test("private and removed spots never come back", async () => {
    expect(await found("новокрестовская")).toEqual([id("novo")]);
    expect(await found("тайная")).toEqual([]);
    expect(await found("старая")).toEqual([]);
  });

  test("distance from the given point breaks ties, then the name", async () => {
    expect(await found("зеркальный", nearPier)).toEqual([id("mirror-a"), id("mirror-b")]);
    expect(await found("зеркальный", nearBay)).toEqual([id("mirror-b"), id("mirror-a")]);
    expect(await found("борт", nearPier)).toEqual([id("mirror-a"), id("mirror-b"), id("zaliv")]);
    expect(await found("борт")).toEqual([id("zaliv"), id("mirror-a"), id("mirror-b")]);
  });

  test("a city's name in any of the apps' languages finds its spots", async () => {
    expect(await found("зеленогорск")).toEqual([id("zaliv")]);
    expect(await found("zelenogorsk борт")).toEqual([id("zaliv")]);
    expect(await found("ゼレノゴルスク")).toEqual([id("zaliv")]);
    expect(await found("зеленогорск зеркальный")).toEqual([]);
  });

  test("a row is what the sync sends", async () => {
    const [row] = (await search("novokrestovskaya")).spots.filter((spotRow) => spotRow.id === id("novo"));
    const page = await read(SyncPageSchema, `/v1/sync/spots?cursor=${row!.version - 1}&limit=1`, { headers: rider.bearer });
    expect(page.items).toEqual([row!]);
  });

  test("limit caps the answer, and a query without letters or digits finds nothing", async () => {
    expect(await found("зеркальный", { limit: 1 })).toHaveLength(1);
    expect((await search("!!!")).spots).toEqual([]);
  });

  test("malformed queries are refused", async () => {
    const paths = [
      "/v1/spots/search",
      "/v1/spots/search?q=",
      "/v1/spots/search?q=%20%20",
      `/v1/spots/search?q=${"a".repeat(101)}`,
      "/v1/spots/search?q=borr&latitude=59.9",
      "/v1/spots/search?q=borr&longitude=30.3",
      "/v1/spots/search?q=borr&limit=0",
      "/v1/spots/search?q=borr&limit=51",
    ];
    const refused = await Promise.all(paths.map(async (path) => `${path} -> ${(await call(path, { headers: rider.bearer })).status}`));
    expect(refused).toEqual(paths.map((path) => `${path} -> 422`));
    expect((await call(`/v1/spots/search?q=${"a".repeat(100)}`, { headers: rider.bearer })).status).toBe(200);
  });
});
