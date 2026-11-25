import type { Database } from "@openskatemap/db";
import { city, clipUpload, spot, spotPhoto, submission, user } from "@openskatemap/db/schema";
import { and, asc, eq, gt, inArray, max, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { City, NearbySpot, SpotCard, SpotDetails, SyncPage } from "../lib/spot-schemas.ts";
import { canSeeSpot } from "./collections.ts";
import { approvedVideos } from "./videos.ts";
import { noVotes, voteTotals } from "./votes.ts";
import { hasBlocked } from "./people.ts";

export const indexColumns = {
  id: spot.id,
  title: spot.title,
  kind: spot.kind,
  condition: spot.condition,
  cityId: spot.cityId,
  location: spot.location,
  version: spot.version,
  cover: { key: spotPhoto.r2Key, width: spotPhoto.width, height: spotPhoto.height, thumbhash: spotPhoto.thumbhash },
  obstacles: spot.obstacles,
};

export const coverJoin = and(eq(spotPhoto.spotId, spot.id), eq(spotPhoto.position, 0));

export const toIndexRow = <Row extends { location: { latitude: number; longitude: number } }>({ location, ...row }: Row) => ({ ...row, ...location });

export async function syncSpots(db: Database, cursor: number, limit: number): Promise<SyncPage> {
  const [latest] = await db.select({ version: max(spot.version) }).from(spot);
  if (cursor > (latest?.version ?? 0)) return { items: [], tombstones: [], nextCursor: 0, hasMore: false, resetRequired: true };

  const rows = await db
    .select({ ...indexColumns, status: spot.status })
    .from(spot)
    .leftJoin(spotPhoto, coverJoin)
    // A fresh install (cursor 0) has nothing to delete, so it gets no tombstones.
    .where(and(gt(spot.version, cursor), eq(spot.visibility, "public"), cursor === 0 ? eq(spot.status, "published") : undefined))
    .orderBy(asc(spot.version))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const published = page.filter((row) => row.status === "published");
  return {
    items: published.map(({ status: _, ...row }) => toIndexRow(row)),
    tombstones: page.filter((row) => row.status === "removed").map((row) => row.id),
    nextCursor: page.at(-1)?.version ?? cursor,
    hasMore: rows.length > limit,
    resetRequired: false,
  };
}

const uploader = alias(user, "uploader");

export async function spotDetails(db: Database, viewerId: string, ids: readonly string[]): Promise<SpotDetails> {
  const rows = await db
    .select({
      id: spot.id,
      title: spot.title,
      description: spot.description,
      kind: spot.kind,
      condition: spot.condition,
      visibility: spot.visibility,
      obstacles: spot.obstacles,
      cityId: spot.cityId,
      location: spot.location,
      version: spot.version,
      createdAt: spot.createdAt,
      addedBy: { id: user.id, name: user.name },
      addedByBlocked: hasBlocked(viewerId, spot.createdBy),
    })
    .from(spot)
    .leftJoin(user, eq(user.id, spot.createdBy))
    .where(and(inArray(spot.id, [...ids]), eq(spot.status, "published"), canSeeSpot(viewerId)));
  const photos =
    rows.length === 0
      ? []
      : await db
          .select({
            spotId: spotPhoto.spotId,
            id: spotPhoto.id,
            key: spotPhoto.r2Key,
            width: spotPhoto.width,
            height: spotPhoto.height,
            thumbhash: spotPhoto.thumbhash,
            namedCredit: spotPhoto.credit,
            uploaderName: uploader.name,
            uploaderBlocked: hasBlocked(viewerId, spotPhoto.uploadedBy),
            position: spotPhoto.position,
            addedAt: spotPhoto.createdAt,
            clip: { key: clipUpload.r2Key, width: clipUpload.width, height: clipUpload.height, durationMs: clipUpload.durationMs },
          })
          .from(spotPhoto)
          .leftJoin(uploader, eq(uploader.id, spotPhoto.uploadedBy))
          .leftJoin(clipUpload, eq(clipUpload.id, spotPhoto.clipId))
          .where(inArray(spotPhoto.spotId, rows.map((row) => row.id)))
          .orderBy(asc(spotPhoto.position));
  const photosBySpot = Map.groupBy(photos, (photo) => photo.spotId);
  const videosBySpot = await approvedVideos(db, viewerId, rows.map((row) => row.id));
  const votesBySpot = await voteTotals(db, viewerId, rows.map((row) => row.id));
  const found = new Set(rows.map((row) => row.id));
  return {
    spots: rows.map(({ location, createdAt, addedBy, addedByBlocked, ...row }) => ({
      ...row,
      ...location,
      addedBy: addedByBlocked ? null : addedBy,
      photos: (photosBySpot.get(row.id) ?? []).map(({ spotId: _, namedCredit, uploaderName, uploaderBlocked, addedAt, clip, ...photo }) => ({
        ...photo,
        credit: namedCredit ?? (uploaderBlocked ? null : uploaderName),
        createdAt: addedAt.toISOString(),
        ...(clip === null ? {} : { clip }),
      })),
      videos: videosBySpot.get(row.id) ?? [],
      votes: votesBySpot.get(row.id) ?? noVotes,
      createdAt: createdAt.toISOString(),
    })),
    missing: ids.filter((id) => !found.has(id)),
  };
}

function nearbyTo(db: Database, origin: SQL, radiusMeters: number) {
  // `::geography` on both sides matches the expression index `spot_location_geography_gist`.
  const distance = sql<number>`ST_Distance(${spot.location}::geography, ${origin})`.mapWith(Number);
  return db
    .select({ id: spot.id, title: spot.title, kind: spot.kind, location: spot.location, distance: distance.as("distance") })
    .from(spot)
    .where(and(eq(spot.status, "published"), eq(spot.visibility, "public"), sql`ST_DWithin(${spot.location}::geography, ${origin}, ${radiusMeters})`))
    .orderBy(distance)
    .limit(50);
}

const toNearby = ({ location, distance, ...row }: { id: string; title: string; kind: NearbySpot["kind"]; location: { latitude: number; longitude: number }; distance: number }) => ({
  ...row,
  ...location,
  distanceMeters: Math.round(distance),
});

export async function nearbySpots(db: Database, latitude: number, longitude: number, radiusMeters: number): Promise<NearbySpot[]> {
  const rows = await nearbyTo(db, sql`ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)::geography`, radiusMeters);
  return rows.map(toNearby);
}

/** `nearbySpots` around each submission's pin, in one query. */
export async function nearbySubmissions(db: Database, submissionIds: readonly string[], radiusMeters: number): Promise<Map<string, NearbySpot[]>> {
  if (submissionIds.length === 0) return new Map();
  const near = nearbyTo(db, sql`${submission.location}::geography`, radiusMeters).as("near");
  const rows = await db
    .select({ submissionId: submission.id, id: near.id, title: near.title, kind: near.kind, location: near.location, distance: near.distance })
    .from(submission)
    .innerJoinLateral(near, sql`true`)
    .where(inArray(submission.id, [...submissionIds]))
    .orderBy(asc(near.distance));
  const bySubmission = new Map<string, NearbySpot[]>();
  for (const { submissionId, ...row } of rows) bySubmission.set(submissionId, [...(bySubmission.get(submissionId) ?? []), toNearby(row)]);
  return bySubmission;
}

const bound = (fn: "ST_XMin" | "ST_XMax" | "ST_YMin" | "ST_YMax") => sql<number>`${sql.raw(fn)}(${city.area})`.mapWith(Number);

export function listCities(db: Database): Promise<City[]> {
  return db
    .select({
      id: city.id,
      slug: city.slug,
      name: city.name,
      names: city.names,
      countryCode: city.countryCode,
      bounds: {
        minLatitude: bound("ST_YMin"),
        minLongitude: bound("ST_XMin"),
        maxLatitude: bound("ST_YMax"),
        maxLongitude: bound("ST_XMax"),
      },
    })
    .from(city)
    .orderBy(asc(city.name));
}

export async function spotCard(db: Database, id: string): Promise<SpotCard | undefined> {
  const [row] = await db
    .select({
      id: spot.id,
      title: spot.title,
      kind: spot.kind,
      city: city.name,
      version: spot.version,
      cover: indexColumns.cover,
    })
    .from(spot)
    .leftJoin(city, eq(city.id, spot.cityId))
    .leftJoin(spotPhoto, coverJoin)
    .where(and(eq(spot.id, id), eq(spot.status, "published"), eq(spot.visibility, "public")));
  return row;
}

