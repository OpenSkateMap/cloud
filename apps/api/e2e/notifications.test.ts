import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Database, openDatabase, schema } from "@openskatemap/db";
import { eq, inArray, sql } from "drizzle-orm";
import type { Submission } from "../src/lib/submission-schemas.ts";
import type { VideoSubmission } from "../src/lib/video-schemas.ts";
import { newSpotsDigest, reviewEscalations, reviewQueueNotice, videoQueueNotice } from "../src/services/notifications.ts";
import { createRider, e2eUrl } from "./support.ts";

const { city, cityEditor, spot, spotVideo, submission, user } = schema;

type Rider = Awaited<ReturnType<typeof createRider>>;

describe.skipIf(!e2eUrl)("notifications (database)", () => {
  const database = e2eUrl ? openDatabase(e2eUrl) : undefined;
  const tag = crypto.randomUUID().slice(0, 8);
  const here = { id: `e2e-city-${tag}-a`, slug: `e2e-${tag}-a`, name: `E2E Here ${tag}` };
  const there = { id: `e2e-city-${tag}-b`, slug: `e2e-${tag}-b`, name: `E2E There ${tag}` };
  const spotIds = [`e2e-spot-${tag}-1`, `e2e-spot-${tag}-2`, `e2e-spot-${tag}-owned`];
  const DAY = 86_400_000;
  let db: Database;
  let submitter: Rider, editorHere: Rider, editorThere: Rider, admin: Rider, owner: Rider;

  const audience = (notice: { audience: object } | undefined) => (notice && "to" in notice.audience ? (notice.audience.to as string[]) : []);
  const videoAt = async (spotId: string, daysAgo: number) => {
    const id = crypto.randomUUID();
    const externalId = crypto.randomUUID().slice(0, 11);
    const createdAt = new Date(Date.now() - daysAgo * DAY);
    await db.insert(spotVideo).values({
      id,
      spotId,
      provider: "youtube",
      externalId,
      url: `https://www.youtube.com/watch?v=${externalId}`,
      submittedBy: submitter.userId,
      createdAt,
      updatedAt: createdAt,
    });
    return id;
  };

  const pending = (cityId: string | null): Submission => ({
    id: crypto.randomUUID(),
    kind: "new_spot",
    status: "pending",
    title: "Ledge spot",
    description: "",
    spotKind: "street",
    obstacles: [],
    condition: "skateable",
    latitude: 0,
    longitude: 0,
    cityId,
    note: "",
    photos: [],
    spotId: null,
    changedFields: [],
    collectionId: null,
    rejectReason: null,
    removal: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  beforeAll(async () => {
    db = (await database!).db;
    [submitter, editorHere, editorThere, admin, owner] = [
      await createRider(db, "Submitter"),
      await createRider(db, "Editor Here"),
      await createRider(db, "Editor There"),
      await createRider(db, "Admin"),
      await createRider(db, "Owner"),
    ];
    await db.update(user).set({ role: "admin" }).where(eq(user.id, admin.userId));
    await db.insert(city).values([
      { ...here, countryCode: "GB", area: sql`ST_Multi(ST_MakeEnvelope(-0.125, 51.50, -0.105, 51.51, 4326))` },
      { ...there, countryCode: "ES", area: sql`ST_Multi(ST_MakeEnvelope(2.13, 41.37, 2.15, 41.39, 4326))` },
    ]);
    for (const [rider, cityId] of [[editorHere, here.id], [editorThere, there.id]] as const) {
      await db.update(user).set({ role: "editor" }).where(eq(user.id, rider.userId));
      await db.insert(cityEditor).values({ cityId, userId: rider.userId });
    }
    await db.insert(spot).values([
      { id: spotIds[0]!, title: "Undercroft", kind: "plaza", location: { latitude: 51.5066, longitude: -0.1169 } },
      { id: spotIds[1]!, title: "Stairs", kind: "street", location: { latitude: 51.505, longitude: -0.115 } },
      // Older than the digest's week, so it never shows there.
      {
        id: spotIds[2]!,
        title: "Owned Bank",
        kind: "street",
        location: { latitude: 51.506, longitude: -0.12 },
        createdBy: owner.userId,
        createdAt: new Date(Date.now() - 30 * DAY),
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(spot).where(inArray(spot.id, spotIds));
    await db.delete(city).where(inArray(city.id, [here.id, there.id]));
    await db.delete(user).where(inArray(user.id, [submitter, editorHere, editorThere, admin, owner].map((rider) => rider.userId)));
    await (await database!).close();
  });

  test("a new spot reaches its city's curators, never its sender, the admins or other cities' curators", async () => {
    const notice = await reviewQueueNotice(db, pending(here.id), submitter.userId);
    const to = audience(notice);
    expect(to).toContain(editorHere.userId);
    expect(to).not.toContain(admin.userId);
    expect(to).not.toContain(editorThere.userId);
    expect(to).not.toContain(submitter.userId);
    expect(notice?.body).toBe(`Ledge spot in ${here.name}`);
    expect(notice?.idempotencyKey).toStartWith("review-queue-");
  });

  test("banned curators and admins, and ex-editors with a leftover city row, hear nothing; a lapsed ban does", async () => {
    const [banned, lapsed, demoted, bannedAdmin] = [
      await createRider(db, "Banned Editor"),
      await createRider(db, "Lapsed Ban"),
      await createRider(db, "Ex-Editor"),
      await createRider(db, "Banned Admin"),
    ];
    const extra = [banned, lapsed, demoted, bannedAdmin].map((rider) => rider.userId);
    try {
      await db.update(user).set({ role: "editor", banned: true }).where(eq(user.id, banned.userId));
      await db.update(user).set({ role: "editor", banned: true, banExpires: new Date(Date.now() - DAY) }).where(eq(user.id, lapsed.userId));
      await db.update(user).set({ role: "admin", banned: true }).where(eq(user.id, bannedAdmin.userId));
      await db.insert(cityEditor).values([banned, lapsed, demoted].map((rider) => ({ cityId: here.id, userId: rider.userId })));

      const curators = audience(await reviewQueueNotice(db, pending(here.id), submitter.userId));
      expect(curators).toContain(lapsed.userId);
      expect(curators).not.toContain(banned.userId);
      expect(curators).not.toContain(demoted.userId);
      expect(audience(await reviewQueueNotice(db, pending(null), submitter.userId))).not.toContain(bannedAdmin.userId);
    } finally {
      await db.delete(cityEditor).where(inArray(cityEditor.userId, extra));
      await db.delete(user).where(inArray(user.id, extra));
    }
  });

  test("a spot outside every city goes to the admins only; an admin's own submission skips them", async () => {
    const outside = await reviewQueueNotice(db, pending(null), submitter.userId);
    const to = outside && "to" in outside.audience ? outside.audience.to : [];
    expect(to).toContain(admin.userId);
    expect(to).not.toContain(editorHere.userId);

    const own = await reviewQueueNotice(db, pending(null), admin.userId);
    expect(own && "to" in own.audience ? own.audience.to : []).not.toContain(admin.userId);
  });

  test("an edit moving a spot to another city asks only curators of both cities, else the admins", async () => {
    const edit: Submission = { ...pending(there.id), kind: "edit_spot", spotId: spotIds[0]!, changedFields: ["location"] };
    const toAdmins = audience(await reviewQueueNotice(db, edit, submitter.userId));
    expect(toAdmins).toContain(admin.userId);
    expect(toAdmins).not.toContain(editorHere.userId);
    expect(toAdmins).not.toContain(editorThere.userId);

    const both = await createRider(db, "Editor Both");
    try {
      await db.update(user).set({ role: "editor" }).where(eq(user.id, both.userId));
      await db.insert(cityEditor).values([here.id, there.id].map((cityId) => ({ cityId, userId: both.userId })));
      expect(audience(await reviewQueueNotice(db, edit, submitter.userId))).toEqual([both.userId]);
    } finally {
      await db.delete(cityEditor).where(eq(cityEditor.userId, both.userId));
      await db.delete(user).where(eq(user.id, both.userId));
    }
  });

  test("the weekly digest counts a city's new public spots, for the people whose map is there", async () => {
    const notices = await newSpotsDigest(db, new Date());
    const ours = notices.find((notice) => "where" in notice.audience && notice.audience.where.eq === here.id);
    expect(ours?.audience).toEqual({ where: { ref: "attributes.cityId", eq: here.id } });
    expect(ours?.title).toBe(`2 new spots in ${here.name}`);
    expect(ours?.body).toBe("Stairs and Undercroft");
    expect(notices.some((notice) => "where" in notice.audience && notice.audience.where.eq === there.id)).toBe(false);
  });

  test("a change to someone's spot asks them first, on its own topic", async () => {
    const videoId = await videoAt(spotIds[2]!, 0);
    const video = { id: videoId, status: "pending" } as VideoSubmission;
    const notice = await videoQueueNotice(db, video, submitter.userId);
    expect(notice).toMatchObject({ audience: { to: [owner.userId] }, topic: "spot-changes", title: "A new video of your spot", body: "Owned Bank" });

    const theirOwn = await videoQueueNotice(db, video, owner.userId);
    expect(theirOwn).toMatchObject({ topic: "review-queue" });
    expect(audience(theirOwn)).toContain(editorHere.userId);
  });

  test("a change nobody decided reaches the city's curators after 3 days and the admins after 7", async () => {
    const fresh = await videoAt(spotIds[2]!, 1);
    const threeDays = await videoAt(spotIds[2]!, 4);
    const aWeek = await videoAt(spotIds[2]!, 8);
    const unowned = await videoAt(spotIds[0]!, 8);
    const notices = await reviewEscalations(db, new Date());
    const sent = (id: string) =>
      notices
        .filter((notice) => notice.idempotencyKey.endsWith(id))
        .map((notice) => [notice.idempotencyKey.replace(`-${id}`, ""), audience(notice).includes(editorHere.userId), audience(notice).includes(admin.userId)]);

    expect(sent(fresh)).toEqual([]);
    expect(sent(threeDays)).toEqual([["review-escalation-curators", true, false]]);
    expect(sent(aWeek)).toEqual([
      ["review-escalation-curators", true, false],
      ["review-escalation-admins", false, true],
    ]);
    // Its curators heard at once, so only the admins are left.
    expect(sent(unowned)).toEqual([["review-escalation-admins", false, true]]);
    expect(notices.find((notice) => notice.idempotencyKey.endsWith(aWeek))?.body).toBe(`Owned Bank in ${here.name} · waiting 3 days`);
    expect(notices.every((notice) => !audience(notice).includes(submitter.userId) && !audience(notice).includes(owner.userId))).toBe(true);
  });

  test("a waiting edit moving a spot to another city skips curators of only one of them", async () => {
    const id = crypto.randomUUID();
    const createdAt = new Date(Date.now() - 8 * DAY);
    await db.insert(submission).values({
      id,
      kind: "edit_spot",
      submittedBy: submitter.userId,
      title: "Owned Bank",
      spotKind: "street",
      location: { latitude: 41.38, longitude: 2.14 },
      spotId: spotIds[2]!,
      changedFields: ["location"],
      createdAt,
      updatedAt: createdAt,
    });
    try {
      const notices = (await reviewEscalations(db, new Date())).filter((notice) => notice.idempotencyKey.endsWith(id));
      expect(notices.map((notice) => notice.idempotencyKey)).toEqual([`review-escalation-admins-${id}`]);
      expect(audience(notices[0])).toContain(admin.userId);
      expect(audience(notices[0])).not.toContain(editorThere.userId);
    } finally {
      await db.delete(submission).where(eq(submission.id, id));
    }
  });
});
