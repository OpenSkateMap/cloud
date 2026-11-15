import type { Database } from "@openskatemap/db";
import { spot, spotVideo, user } from "@openskatemap/db/schema";
import { and, asc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { AppError } from "../lib/errors.ts";
import { isUniqueViolation } from "../lib/transaction.ts";
import { err, ok, type Result } from "../lib/result.ts";
import type { SpotVideo } from "../lib/spot-schemas.ts";
import type { Fetch } from "../auth/apple-tokens.ts";
import { parseVideoLink, thumbnailUrl, youtubeAvailability } from "../lib/video-links.ts";
import type { VideoDraft, VideoReviewCard, VideoSubmission } from "../lib/video-schemas.ts";
import { hasBlocked } from "./people.ts";
import { inTransaction } from "../lib/transaction";

const unsupportedLink: AppError = { code: "validation_failed", message: "Use a link to a YouTube video or an Instagram post or reel" };
const alreadyThere: AppError = { code: "conflict", message: "This video is already on the spot, or waiting for review" };
const unavailable: AppError = { code: "validation_failed", message: "This video is private or no longer on YouTube" };

const submissionColumns = {
  id: spotVideo.id,
  spotId: spotVideo.spotId,
  provider: spotVideo.provider,
  externalId: spotVideo.externalId,
  url: spotVideo.url,
  startSeconds: spotVideo.startSeconds,
  caption: spotVideo.caption,
  status: spotVideo.status,
  rejectReason: spotVideo.rejectReason,
  createdAt: spotVideo.createdAt,
  updatedAt: spotVideo.updatedAt,
};

type SubmissionRow = { provider: VideoSubmission["provider"]; externalId: string; createdAt: Date; updatedAt: Date };

const toSubmission = <Row extends SubmissionRow>({ createdAt, updatedAt, ...row }: Row) => ({
  ...row,
  thumbnailUrl: thumbnailUrl(row.provider, row.externalId),
  createdAt: createdAt.toISOString(),
  updatedAt: updatedAt.toISOString(),
});

export async function loadVideoSubmissions(db: Database, where: SQL | undefined): Promise<VideoSubmission[]> {
  const rows = await db.select(submissionColumns).from(spotVideo).where(where).orderBy(asc(spotVideo.createdAt));
  return rows.map(toSubmission);
}

export async function saveVideo(
  db: Database,
  submitterId: string,
  spotId: string,
  id: string,
  draft: VideoDraft,
  fetcher: Fetch = fetch,
): Promise<Result<VideoSubmission, AppError>> {
  const link = parseVideoLink(draft.url);
  if (link === null) return err(unsupportedLink);
  if ((await db.$count(spot, and(eq(spot.id, spotId), eq(spot.status, "published"), eq(spot.visibility, "public")))) === 0) {
    return err({ code: "not_found", message: "No such spot" });
  }
  if (
    link.provider === "youtube" &&
    (await db.$count(spotVideo, eq(spotVideo.id, id))) === 0 &&
    (await youtubeAvailability(link.externalId, fetcher)) === "unavailable"
  ) {
    return err(unavailable);
  }
  const fields = { provider: link.provider, externalId: link.externalId, url: link.url, startSeconds: link.startSeconds, caption: draft.caption };
  try {
    const written = await inTransaction(db, async (tx): Promise<Result<void, AppError>> => {
      await tx.insert(spotVideo).values({ id, spotId, submittedBy: submitterId, ...fields }).onConflictDoNothing({ target: spotVideo.id });
      const [row] = await tx
        .select({ submittedBy: spotVideo.submittedBy, spotId: spotVideo.spotId, status: spotVideo.status })
        .from(spotVideo)
        .where(eq(spotVideo.id, id))
        .for("update");
      if (row === undefined) return err(alreadyThere);
      if (row.submittedBy !== submitterId) return err({ code: "forbidden", message: "This video id belongs to someone else" });
      if (row.spotId !== spotId) return err({ code: "validation_failed", message: "This video id was sent for another spot" });
      if (row.status !== "pending") return ok(undefined);
      await tx.update(spotVideo).set({ ...fields, updatedAt: new Date() }).where(eq(spotVideo.id, id));
      return ok(undefined);
    });
    if (written.isErr()) return err(written.error);
  } catch (error) {
    if (isUniqueViolation(error)) return err(alreadyThere);
    throw error;
  }
  const [saved] = await loadVideoSubmissions(db, eq(spotVideo.id, id));
  return saved ? ok(saved) : err({ code: "internal_error", message: "The video was saved but could not be read back" });
}

export async function approvedVideos(db: Database, viewerId: string, spotIds: readonly string[]): Promise<Map<string, SpotVideo[]>> {
  if (spotIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: spotVideo.id,
      spotId: spotVideo.spotId,
      provider: spotVideo.provider,
      externalId: spotVideo.externalId,
      url: spotVideo.url,
      startSeconds: spotVideo.startSeconds,
      caption: spotVideo.caption,
      createdAt: spotVideo.createdAt,
      addedBy: { id: user.id, name: user.name },
      addedByBlocked: hasBlocked(viewerId, spotVideo.submittedBy),
    })
    .from(spotVideo)
    .leftJoin(user, eq(user.id, spotVideo.submittedBy))
    .where(and(inArray(spotVideo.spotId, [...spotIds]), eq(spotVideo.status, "approved")))
    .orderBy(asc(spotVideo.createdAt));
  const videos = rows.map(({ createdAt, addedBy, addedByBlocked, ...row }) => ({
    ...row,
    thumbnailUrl: thumbnailUrl(row.provider, row.externalId),
    addedBy: addedByBlocked ? null : addedBy,
    createdAt: createdAt.toISOString(),
  }));
  return Map.groupBy(videos, (video) => video.spotId);
}

/** Pending videos of spots in the reviewer's cities (`null`: everywhere), plus others' videos of spots they added. */
export async function pendingVideos(
  db: Database,
  reviewer: { readonly id: string; readonly cityIds: readonly string[] | null },
  cityId: string | undefined,
  limit: number,
): Promise<Omit<VideoReviewCard, "reviewAs">[]> {
  const { id, cityIds } = reviewer;
  const inCities = cityIds === null ? sql`true` : cityIds.length > 0 ? inArray(spot.cityId, [...cityIds]) : sql`false`;
  const ownSpot = and(eq(spot.createdBy, id), sql`${spotVideo.submittedBy} is distinct from ${id}`);
  const rows = await db
    .select({
      ...submissionColumns,
      spot: { id: spot.id, title: spot.title, kind: spot.kind, cityId: spot.cityId },
      submitter: { id: user.id, name: user.name },
    })
    .from(spotVideo)
    .innerJoin(spot, eq(spot.id, spotVideo.spotId))
    .leftJoin(user, eq(user.id, spotVideo.submittedBy))
    .where(
      and(
        eq(spotVideo.status, "pending"),
        eq(spot.status, "published"),
        cityId === undefined ? undefined : eq(spot.cityId, cityId),
        or(inCities, ownSpot),
      ),
    )
    .orderBy(asc(spotVideo.createdAt))
    .limit(limit);
  return rows.map(toSubmission);
}
