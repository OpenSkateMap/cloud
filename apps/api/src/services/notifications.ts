import type { Database } from "@openskatemap/db";
import { city, cityEditor, collection, spot, spotVideo, submission, user } from "@openskatemap/db/schema";
import { type AnyColumn, and, asc, desc, eq, gte, inArray, isNotNull, lte, not, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Context } from "hono";
import type { AppEnv } from "../env.ts";
import { PUSH_TOPICS, type PushMessage, parsePushSettings, sendPush } from "../lib/buzzkit.ts";
import { logFailure } from "../lib/log.ts";
import type { Submission } from "../lib/submission-schemas.ts";
import type { VideoSubmission } from "../lib/video-schemas.ts";
import { curatorCities } from "./review.ts";
import { isPrivateSubmission } from "./submissions.ts";

const SITE = "https://openskatemap.app";
const spotLink = (id: string) => `${SITE}/spots/${encodeURIComponent(id)}`;
const collectionLink = (id: string) => `${SITE}/collections/${encodeURIComponent(id)}`;

const SPOT_REJECT_REASONS: Record<NonNullable<Submission["rejectReason"]>, string> = {
  duplicate: "Already on the map",
  not_a_spot: "Not a skate spot",
  wrong_location: "Pin in the wrong place",
  private_property: "On private property",
  photo_rights: "Photo rights unclear",
};
const VIDEO_REJECT_REASONS: Record<NonNullable<VideoSubmission["rejectReason"]>, string> = {
  duplicate: "Already on this spot",
  wrong_spot: "Not this spot",
  not_skating: "No skating in it",
  inappropriate: "Inappropriate",
};

// Compose on the request's connection (it closes with the response), then send in `waitUntil`.
export async function notifyAfter(c: Context<AppEnv>, compose: (db: Database) => Promise<PushMessage | undefined>): Promise<void> {
  const settings = parsePushSettings(c.env);
  if (!settings) return;
  try {
    const message = await compose(c.var.database.db);
    if (message) c.executionCtx.waitUntil(sendPush(settings, message));
  } catch (error) {
    logFailure("Push not composed", error);
  }
}

const decidedBy = (byOwner: boolean, approved: boolean) =>
  byOwner ? (approved ? "The spot's owner approved it" : "The spot's owner looked at it") : approved ? "A curator approved it" : "A curator looked at it";

export async function reviewResultNotice(db: Database, decided: Submission): Promise<PushMessage | undefined> {
  if (decided.status === "pending") return undefined;
  const [row] = await db
    .select({ submitterId: submission.submittedBy, reviewedBy: submission.reviewedBy, spotOwnerId: spot.createdBy, isPrivate: isPrivateSubmission })
    .from(submission)
    .leftJoin(spot, eq(spot.id, submission.spotId))
    .where(eq(submission.id, decided.id));
  if (!row?.submitterId || row.isPrivate) return undefined;
  const isEdit = decided.kind === "edit_spot";
  const byOwner = isEdit && row.reviewedBy !== null && row.reviewedBy === row.spotOwnerId;
  const approved = decided.status === "approved" && decided.spotId !== null;
  return {
    audience: { to: [row.submitterId] },
    topic: PUSH_TOPICS.reviewResults,
    title: approved
      ? isEdit ? `Your edit to ${decided.title} is live` : `${decided.title} is on the map`
      : isEdit ? `Your edit to ${decided.title} wasn't applied` : `${decided.title} wasn't added`,
    body: approved || decided.rejectReason === null ? decidedBy(byOwner, approved) : SPOT_REJECT_REASONS[decided.rejectReason],
    destination: approved && decided.spotId !== null ? { deepLink: spotLink(decided.spotId) } : { action: { name: "open_contribute" } },
    idempotencyKey: `review-result-${decided.id}-${decided.status}-${decided.updatedAt}`,
  };
}

export async function videoResultNotice(db: Database, decided: VideoSubmission): Promise<PushMessage | undefined> {
  if (decided.status === "pending") return undefined;
  const [row] = await db
    .select({
      submitterId: spotVideo.submittedBy,
      reviewedBy: spotVideo.reviewedBy,
      spotId: spot.id,
      spotTitle: spot.title,
      spotOwnerId: spot.createdBy,
    })
    .from(spotVideo)
    .innerJoin(spot, eq(spot.id, spotVideo.spotId))
    .where(eq(spotVideo.id, decided.id));
  if (!row?.submitterId) return undefined;
  const approved = decided.status === "approved";
  const byOwner = row.reviewedBy !== null && row.reviewedBy === row.spotOwnerId;
  return {
    audience: { to: [row.submitterId] },
    topic: PUSH_TOPICS.reviewResults,
    title: approved ? `Your video of ${row.spotTitle} is up` : `Your video of ${row.spotTitle} wasn't added`,
    body: approved || decided.rejectReason === null ? decidedBy(byOwner, approved) : VIDEO_REJECT_REASONS[decided.rejectReason],
    destination: { deepLink: spotLink(row.spotId) },
    idempotencyKey: `video-result-${decided.id}-${decided.status}-${decided.updatedAt}`,
  };
}

// Only decides who is pinged; anyone can act any time. Others' changes to your spot ping you, then its city's
// curators after 3 days; a new spot pings the curators at once. Admins hear after 7. An empty stage is skipped.
export const ESCALATION_DAYS = { curators: 3, admins: 7 } as const;

type Stage = "owner" | "curators" | "admins";

export interface PendingChange {
  readonly id: string;
  readonly what: "spot" | "edit" | "video";
  readonly title: string;
  readonly cityId: string | null;
  readonly fromCityId?: string | null;
  readonly spotOwnerId: string | null;
  readonly ownerActive: boolean;
  readonly submittedBy: string | null;
}

// Mirrors `requireUser`'s ban rule, so a banned account isn't pinged.
const notBanned = ({ banned, banExpires }: { banned: AnyColumn; banExpires: AnyColumn }) =>
  sql<boolean>`not (coalesce(${banned}, false) and (${banExpires} is null or ${banExpires} > now()))`;

const owner = alias(user, "spot_owner");
const ownerActive = sql<boolean>`(${owner.id} is not null and ${notBanned(owner)})`;

interface Reach {
  readonly admins: readonly string[];
  readonly cities: ReadonlyMap<string, { readonly name: string; readonly curators: ReadonlySet<string> }>;
}

async function reachOf(db: Database, cityIds: readonly (string | null)[]): Promise<Reach> {
  const ids = [...new Set(cityIds.filter((cityId) => cityId !== null))];
  const admins = await db.select({ id: user.id }).from(user).where(and(eq(user.role, "admin"), notBanned(user)));
  // A city_editor row counts while the account is an editor, as in `reviewScope`.
  const rows =
    ids.length === 0
      ? []
      : await db
          .select({ cityId: city.id, name: city.name, curatorId: user.id })
          .from(city)
          .leftJoin(cityEditor, eq(cityEditor.cityId, city.id))
          .leftJoin(user, and(eq(user.id, cityEditor.userId), inArray(user.role, ["editor", "admin"]), notBanned(user)))
          .where(inArray(city.id, ids));
  const cities = new Map<string, { name: string; curators: Set<string> }>();
  for (const row of rows) {
    const entry = cities.get(row.cityId) ?? { name: row.name, curators: new Set<string>() };
    if (row.curatorId !== null) entry.curators.add(row.curatorId);
    cities.set(row.cityId, entry);
  }
  return { admins: admins.map((row) => row.id), cities };
}

function people(reach: Reach, stage: Exclude<Stage, "owner">, change: PendingChange): string[] {
  const other = (id: string) => id !== change.submittedBy && id !== change.spotOwnerId;
  if (stage === "admins") return reach.admins.filter(other);
  // Only those who can decide it (`reviewerRole`): curators of every city it touches; outside every city, nobody.
  const [first, ...rest] = curatorCities(change).map((cityId) => (cityId === null ? undefined : reach.cities.get(cityId)?.curators));
  if (first === undefined || rest.some((curators) => curators === undefined)) return [];
  return [...first].filter((id) => other(id) && rest.every((curators) => curators?.has(id)));
}

const ownerToAsk = (change: PendingChange) =>
  change.spotOwnerId !== null && change.spotOwnerId !== change.submittedBy && change.ownerActive ? change.spotOwnerId : undefined;

function firstStage(reach: Reach, change: PendingChange): { stage: Stage; to: string[] } {
  const asked = ownerToAsk(change);
  if (asked !== undefined) return { stage: "owner", to: [asked] };
  const curators = people(reach, "curators", change);
  return curators.length > 0 ? { stage: "curators", to: curators } : { stage: "admins", to: people(reach, "admins", change) };
}

const QUEUE_TITLES = { spot: "A new spot to review", edit: "A suggested edit to review", video: "A new video to review" } as const;

function place(reach: Reach, change: PendingChange): string {
  const name = change.cityId === null ? undefined : reach.cities.get(change.cityId)?.name;
  return name === undefined ? change.title : `${change.title} in ${name}`;
}

// Keep these keys stable: BuzzKit dedupes on them, so a resent submission isn't announced twice.
const firstKey = (change: PendingChange) => `${change.what === "video" ? "video-queue" : "review-queue"}-${change.id}`;

async function pendingChangeNotice(db: Database, change: PendingChange): Promise<PushMessage | undefined> {
  const asked = ownerToAsk(change);
  if (asked !== undefined) {
    return {
      audience: { to: [asked] },
      topic: PUSH_TOPICS.spotChanges,
      title: change.what === "video" ? "A new video of your spot" : "A suggested edit to your spot",
      body: change.title,
      destination: { action: { name: "open_review_queue" } },
      idempotencyKey: `spot-changes-${change.id}`,
    };
  }
  const reach = await reachOf(db, curatorCities(change));
  return {
    audience: { to: firstStage(reach, change).to },
    topic: PUSH_TOPICS.reviewQueue,
    title: QUEUE_TITLES[change.what],
    body: place(reach, change),
    destination: { action: { name: "open_review_queue" } },
    idempotencyKey: firstKey(change),
  };
}

export async function reviewQueueNotice(db: Database, saved: Submission, submitterId: string): Promise<PushMessage | undefined> {
  if (saved.status !== "pending") return undefined;
  const isEdit = saved.kind === "edit_spot";
  const [current] =
    isEdit && saved.spotId !== null
      ? await db
          .select({ title: spot.title, ownerId: spot.createdBy, cityId: spot.cityId, ownerActive })
          .from(spot)
          .leftJoin(owner, eq(owner.id, spot.createdBy))
          .where(eq(spot.id, saved.spotId))
      : [];
  return pendingChangeNotice(db, {
    id: saved.id,
    what: isEdit ? "edit" : "spot",
    title: current?.title ?? saved.title,
    cityId: saved.cityId,
    ...(isEdit ? { fromCityId: current?.cityId ?? null } : {}),
    spotOwnerId: current?.ownerId ?? null,
    ownerActive: current?.ownerActive ?? false,
    submittedBy: submitterId,
  });
}

export async function videoQueueNotice(db: Database, saved: VideoSubmission, submitterId: string): Promise<PushMessage | undefined> {
  if (saved.status !== "pending") return undefined;
  const [row] = await db
    .select({ title: spot.title, cityId: spot.cityId, spotOwnerId: spot.createdBy, ownerActive })
    .from(spotVideo)
    .innerJoin(spot, eq(spot.id, spotVideo.spotId))
    .leftJoin(owner, eq(owner.id, spot.createdBy))
    .where(eq(spotVideo.id, saved.id));
  if (!row) return undefined;
  return pendingChangeNotice(db, { id: saved.id, what: "video", ...row, submittedBy: submitterId });
}

const DAY_MS = 86_400_000;
// shortcut: a change pending longer than this is never escalated again; by then both stages had their days.
const ESCALATION_LOOKBACK_DAYS = 30;

/** Pending public changes old enough for another stage. */
export async function pendingChanges(db: Database, now: Date): Promise<(PendingChange & { createdAt: Date })[]> {
  const newest = new Date(now.getTime() - ESCALATION_DAYS.curators * DAY_MS);
  const oldest = new Date(now.getTime() - ESCALATION_LOOKBACK_DAYS * DAY_MS);
  const submissions = await db
    .select({
      id: submission.id,
      kind: submission.kind,
      title: sql<string>`coalesce(${spot.title}, ${submission.title})`,
      cityId: submission.cityId,
      spotCityId: spot.cityId,
      spotOwnerId: sql<string | null>`case when ${submission.kind} = 'edit_spot' then ${spot.createdBy} end`,
      ownerActive,
      submittedBy: submission.submittedBy,
      createdAt: submission.createdAt,
    })
    .from(submission)
    .leftJoin(spot, eq(spot.id, submission.spotId))
    .leftJoin(owner, eq(owner.id, spot.createdBy))
    .where(
      and(
        eq(submission.status, "pending"),
        not(isPrivateSubmission),
        lte(submission.createdAt, newest),
        gte(submission.createdAt, oldest),
      ),
    )
    .orderBy(asc(submission.createdAt));
  const videos = await db
    .select({
      id: spotVideo.id,
      title: spot.title,
      cityId: spot.cityId,
      spotOwnerId: spot.createdBy,
      ownerActive,
      submittedBy: spotVideo.submittedBy,
      createdAt: spotVideo.createdAt,
    })
    .from(spotVideo)
    .innerJoin(spot, eq(spot.id, spotVideo.spotId))
    .leftJoin(owner, eq(owner.id, spot.createdBy))
    .where(and(eq(spotVideo.status, "pending"), eq(spot.status, "published"), lte(spotVideo.createdAt, newest), gte(spotVideo.createdAt, oldest)))
    .orderBy(asc(spotVideo.createdAt));
  return [
    ...submissions.map(({ kind, spotCityId, ...row }) =>
      kind === "edit_spot" ? { ...row, what: "edit" as const, fromCityId: spotCityId } : { ...row, what: "spot" as const },
    ),
    ...videos.map((row) => ({ ...row, what: "video" as const })),
  ];
}

/** Safe to rerun daily: a stage already sent repeats its idempotency key, which BuzzKit replays without sending. */
export async function reviewEscalations(db: Database, now: Date): Promise<PushMessage[]> {
  const changes = await pendingChanges(db, now);
  const reach = await reachOf(db, changes.flatMap(curatorCities));
  return changes.flatMap((change) => {
    const days = (now.getTime() - change.createdAt.getTime()) / DAY_MS;
    const { stage } = firstStage(reach, change);
    const due: Exclude<Stage, "owner">[] = [];
    if (stage === "owner" && days >= ESCALATION_DAYS.curators) due.push("curators");
    if (stage !== "admins" && days >= ESCALATION_DAYS.admins) due.push("admins");
    return due.flatMap((next): PushMessage[] => {
      const to = people(reach, next, change);
      if (to.length === 0) return [];
      return [
        {
          audience: { to },
          topic: PUSH_TOPICS.reviewQueue,
          title: QUEUE_TITLES[change.what],
          body: `${place(reach, change)} · waiting ${next === "curators" ? "3 days" : "a week"}`,
          destination: { action: { name: "open_review_queue" } },
          idempotencyKey: `review-escalation-${next}-${change.id}`,
        },
      ];
    });
  });
}

export async function collectionInvitationNotice(
  db: Database,
  inviter: { name: string },
  collectionId: string,
  invited: { inviteId: string; userId: string },
): Promise<PushMessage | undefined> {
  const [row] = await db.select({ name: collection.name }).from(collection).where(eq(collection.id, collectionId));
  if (!row) return undefined;
  return {
    audience: { to: [invited.userId] },
    topic: PUSH_TOPICS.collectionInvites,
    title: `${inviter.name} invited you to a collection`,
    body: row.name,
    destination: { deepLink: collectionLink(collectionId) },
    idempotencyKey: `collection-invitation-${invited.inviteId}`,
  };
}

export function collectionRequestNotice(
  requester: { id: string; name: string },
  collectionId: string,
  request: { name: string; managers: string[] },
): PushMessage {
  return {
    audience: { to: request.managers.filter((id) => id !== requester.id) },
    topic: PUSH_TOPICS.collectionInvites,
    title: `${requester.name} asked to join`,
    body: request.name,
    destination: { deepLink: collectionLink(collectionId) },
    // Once per person and collection, however often they ask.
    idempotencyKey: `collection-request-${collectionId}-${requester.id}`,
  };
}

export async function collectionJoinedNotice(
  db: Database,
  approver: { name: string },
  collectionId: string,
  memberId: string,
): Promise<PushMessage | undefined> {
  const [row] = await db.select({ name: collection.name }).from(collection).where(eq(collection.id, collectionId));
  if (!row) return undefined;
  return {
    audience: { to: [memberId] },
    topic: PUSH_TOPICS.collectionInvites,
    title: `${approver.name} let you in`,
    body: row.name,
    destination: { deepLink: collectionLink(collectionId) },
    idempotencyKey: `collection-joined-${collectionId}-${memberId}`,
  };
}

export async function newSpotsDigest(db: Database, now: Date): Promise<PushMessage[]> {
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const added = await db
    .select({ cityId: spot.cityId, cityName: city.name, title: spot.title })
    .from(spot)
    .innerJoin(city, eq(city.id, spot.cityId))
    .where(and(eq(spot.status, "published"), eq(spot.visibility, "public"), isNotNull(spot.cityId), gte(spot.createdAt, since)))
    .orderBy(desc(spot.createdAt), spot.title);
  const byCity = Map.groupBy(added, (row) => row.cityId ?? "");
  const week = now.toISOString().slice(0, 10);
  return Array.from(byCity, ([cityId, rows]) => {
    const count = rows.length;
    const named = rows.slice(0, 3).map((row) => row.title);
    const more = count - named.length;
    return {
      audience: { where: { ref: "attributes.cityId", eq: cityId } },
      topic: PUSH_TOPICS.newSpots,
      title: `${count === 1 ? "A new spot" : `${count} new spots`} in ${rows[0]?.cityName ?? ""}`,
      body: more > 0 ? `${named.join(", ")} and ${more} more` : listed(named),
      idempotencyKey: `new-spots-${cityId}-${week}`,
      ttlSeconds: 2 * 86_400,
    } satisfies PushMessage;
  });
}

export function listed(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
