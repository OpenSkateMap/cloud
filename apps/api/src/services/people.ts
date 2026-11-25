import type { Database } from "@openskatemap/db";
import { city, cityEditor, photoUpload, profile, report, spot, spotVideo, submission, user, userBlock } from "@openskatemap/db/schema";
import { type AnyColumn, and, countDistinct, desc, eq, not, type SQL, sql } from "drizzle-orm";
import { RoleSchema } from "../auth/roles.ts";
import type { AppError } from "../lib/errors.ts";
import { isUniqueViolation } from "../lib/transaction.ts";
import type { BlockedUser, ClearableProfileField, ProfileUpdate, PublicProfile, ReportInput } from "../lib/people-schemas.ts";
import { err, ok, type Result } from "../lib/result.ts";
import { isAllowedUsername } from "../lib/usernames.ts";
import { isPrivateSubmission, isTakenDown } from "./submissions.ts";

const notFound: AppError = { code: "not_found", message: "No such person" };

type Person = AnyColumn | SQL | string;

/** SQL: `blocker` has blocked `blocked`; either is a column or an id. */
export const hasBlocked = (blocker: Person, blocked: Person) =>
  sql<boolean>`exists (select 1 from ${userBlock} where ${userBlock.blockerId} = ${blocker} and ${userBlock.blockedId} = ${blocked})`;

export const blocks = (db: Database, blockerId: string, blockedId: string) =>
  db.$count(userBlock, and(eq(userBlock.blockerId, blockerId), eq(userBlock.blockedId, blockedId))).then((count) => count > 0);

export async function publicProfile(db: Database, viewerId: string, userId: string): Promise<Result<PublicProfile, AppError>> {
  const [person] = await db
    .select({
      id: user.id,
      name: user.name,
      role: user.role,
      createdAt: user.createdAt,
      username: profile.username,
      bio: profile.bio,
      avatarKey: photoUpload.r2Key,
      avatarThumbhash: profile.avatarThumbhash,
      instagram: profile.instagram,
      tiktok: profile.tiktok,
      youtube: profile.youtube,
      x: profile.x,
      telegram: profile.telegram,
      website: profile.website,
    })
    .from(user)
    .leftJoin(profile, eq(profile.userId, user.id))
    .leftJoin(photoUpload, eq(photoUpload.id, profile.avatarPhotoId))
    .where(eq(user.id, userId));
  if (!person || (viewerId !== userId && (await blocks(db, userId, viewerId)))) return err(notFound);

  const editorOf = await db
    .select({ id: city.id, name: city.name })
    .from(cityEditor)
    .innerJoin(city, eq(city.id, cityEditor.cityId))
    .where(eq(cityEditor.userId, userId))
    .orderBy(city.name);
  const [stats] = await db
    .select({
      submitted: sql<number>`count(*)`.mapWith(Number),
      approved: sql<number>`count(*) filter (where ${submission.status} = 'approved')`.mapWith(Number),
      // The spot's city, not the submission's: saveCity() re-files spots, while a decided submission keeps the city it had.
      cities: countDistinct(sql`case when ${submission.status} = 'approved' then ${spot.cityId} end`),
    })
    .from(submission)
    .leftJoin(spot, eq(spot.id, submission.spotId))
    .where(and(eq(submission.submittedBy, userId), not(isPrivateSubmission), not(isTakenDown)));

  return ok({
    id: person.id,
    name: person.name,
    username: person.username,
    bio: person.bio ?? "",
    avatar: person.avatarKey !== null && person.avatarThumbhash !== null ? { key: person.avatarKey, thumbhash: person.avatarThumbhash } : null,
    handles: {
      instagram: person.instagram,
      tiktok: person.tiktok,
      youtube: person.youtube,
      x: person.x,
      telegram: person.telegram,
      website: person.website,
    },
    role: RoleSchema.catch("user").parse(person.role),
    editorOf,
    stats: stats ?? { submitted: 0, approved: 0, cities: 0 },
    joinedAt: person.createdAt.toISOString(),
    blockedByMe: viewerId !== userId && (await blocks(db, viewerId, userId)),
  });
}

const CLEARED = {
  username: { username: null },
  bio: { bio: "" },
  avatar: { avatarPhotoId: null, avatarThumbhash: null },
  instagram: { instagram: null },
  tiktok: { tiktok: null },
  youtube: { youtube: null },
  x: { x: null },
  telegram: { telegram: null },
  website: { website: null },
} as const satisfies Record<ClearableProfileField, Partial<typeof profile.$inferInsert>>;

export async function updateProfile(db: Database, userId: string, update: ProfileUpdate): Promise<Result<PublicProfile, AppError>> {
  const { name, avatar, handles, clear = [], ...rest } = update;
  if (rest.username !== undefined && !isAllowedUsername(rest.username)) return err({ code: "conflict", message: "That username isn't available" });
  if (avatar) {
    const owned = await db.$count(photoUpload, and(eq(photoUpload.id, avatar.photoId), eq(photoUpload.uploadedBy, userId)));
    if (owned === 0) return err({ code: "validation_failed", message: "Upload the avatar first", details: { missingPhotos: [avatar.photoId] } });
  }
  const changes = {
    ...rest,
    ...handles,
    ...(avatar === undefined ? {} : { avatarPhotoId: avatar.photoId, avatarThumbhash: avatar.thumbhash }),
    ...clear.reduce<Partial<typeof profile.$inferInsert>>((emptied, field) => ({ ...emptied, ...CLEARED[field] }), {}),
    updatedAt: new Date(),
  };
  try {
    await db.transaction(async (tx) => {
      if (name !== undefined) await tx.update(user).set({ name, updatedAt: new Date() }).where(eq(user.id, userId));
      await tx.insert(profile).values({ userId, ...changes }).onConflictDoUpdate({ target: profile.userId, set: changes });
    });
  } catch (error) {
    if (isUniqueViolation(error)) return err({ code: "conflict", message: "That username is taken" });
    throw error;
  }
  return publicProfile(db, userId, userId);
}

export async function fileReport(db: Database, reporterId: string, input: ReportInput): Promise<Result<{ id: string }, AppError>> {
  if (input.targetKind === "user" && input.targetId === reporterId) return err({ code: "validation_failed", message: "You can't report yourself" });
  const exists =
    input.targetKind === "spot"
      ? await db.$count(spot, eq(spot.id, input.targetId))
      : input.targetKind === "video"
        ? await db.$count(spotVideo, eq(spotVideo.id, input.targetId))
        : await db.$count(user, eq(user.id, input.targetId));
  if (exists === 0) return err({ code: "not_found", message: `No such ${input.targetKind}` });
  const [filed] = await db
    .insert(report)
    .values({ id: sql`uuidv7()::text`, reporterId, ...input })
    .returning({ id: report.id });
  return filed ? ok(filed) : err({ code: "internal_error", message: "The report was not saved" });
}

export async function blockUser(db: Database, blockerId: string, blockedId: string): Promise<Result<{ blocked: true }, AppError>> {
  if (blockerId === blockedId) return err({ code: "validation_failed", message: "You can't block yourself" });
  if ((await db.$count(user, eq(user.id, blockedId))) === 0) return err(notFound);
  await db.insert(userBlock).values({ blockerId, blockedId }).onConflictDoNothing();
  return ok({ blocked: true });
}

export async function unblockUser(db: Database, blockerId: string, blockedId: string) {
  await db.delete(userBlock).where(and(eq(userBlock.blockerId, blockerId), eq(userBlock.blockedId, blockedId)));
  return { blocked: false as const };
}

export async function blockedUsers(db: Database, blockerId: string): Promise<BlockedUser[]> {
  const rows = await db
    .select({ id: user.id, name: user.name, username: profile.username, blockedAt: userBlock.createdAt })
    .from(userBlock)
    .innerJoin(user, eq(user.id, userBlock.blockedId))
    .leftJoin(profile, eq(profile.userId, user.id))
    .where(eq(userBlock.blockerId, blockerId))
    .orderBy(desc(userBlock.createdAt));
  return rows.map(({ blockedAt, ...row }) => ({ ...row, blockedAt: blockedAt.toISOString() }));
}
