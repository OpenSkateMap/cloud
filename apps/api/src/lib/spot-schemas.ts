import { z } from "@hono/zod-openapi";
import { CITY_LANGUAGES, SPOT_CONDITIONS, SPOT_KINDS, SPOT_REMOVAL_REASONS, SPOT_VISIBILITIES, VIDEO_PROVIDERS } from "@openskatemap/db/schema";

export const SpotKindSchema = z.enum(SPOT_KINDS).openapi("SpotKind");
export const SpotConditionSchema = z.enum(SPOT_CONDITIONS).openapi("SpotCondition");
export const SpotVisibilitySchema = z
  .enum(SPOT_VISIBILITIES)
  .openapi("SpotVisibility", { description: "public: on the map. private: only in collections, seen by their people" });

export const IdSchema = z.string().regex(/^[\w-]{1,64}$/);

export const SpotRemovalReasonSchema = z
  .enum(SPOT_REMOVAL_REASONS)
  .openapi("SpotRemovalReason", { description: "Why an admin took a spot down; its submitter sees it" });

export const SpotRemovalSchema = z
  .object({ reason: SpotRemovalReasonSchema, removedAt: z.iso.datetime() })
  .openapi("SpotRemoval", { description: "An admin's takedown; on a submission, the history keeps its row and says why" });

const latitude = z.number().min(-90).max(90);
const longitude = z.number().min(-180).max(180);

export const SpotCoverSchema = z
  .object({ key: z.string(), width: z.int(), height: z.int(), thumbhash: z.string() })
  .openapi("SpotCover");

export const SpotCardSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    kind: SpotKindSchema,
    city: z.string().nullable().openapi({ description: "The city's name; null outside every city" }),
    cover: SpotCoverSchema.nullable(),
    version: z.int().openapi({ description: "Changes whenever the spot does; part of the card image's URL" }),
  })
  .strict()
  .openapi("SpotCard");

export const SpotIndexRowSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    kind: SpotKindSchema,
    condition: SpotConditionSchema,
    cityId: z.string().nullable(),
    latitude,
    longitude,
    version: z.int().openapi({ description: "Increases with every change to any spot; the sync cursor" }),
    cover: SpotCoverSchema.nullable(),
    obstacles: z.array(z.string()).openapi({ description: "What's there to skate (ledges, rails, …), so apps can filter the map offline" }),
  })
  .openapi("SpotIndexRow");

export const SyncPageSchema = z
  .object({
    items: z.array(SpotIndexRowSchema).openapi({ description: "Published spots changed after the cursor, oldest first" }),
    tombstones: z
      .array(z.string())
      .openapi({ description: "Ids of spots removed after the cursor; delete them locally. Always empty for cursor 0: a fresh install has nothing to delete" }),
    nextCursor: z.int().openapi({ description: "Pass back as `cursor`; store it only after applying this page" }),
    hasMore: z.boolean().openapi({ description: "Another page is ready now; ask again right away" }),
    resetRequired: z.boolean().openapi({
      description: "The cursor is not one this server issued (its data was reset). Re-index from cursor 0 without wiping first",
    }),
  })
  .openapi("SyncPage");

export const SpotPhotoClipSchema = z
  .object({
    key: z.string().openapi({ description: "The MP4 at https://images.openskatemap.app/<key>, served as it is (no image transformations)" }),
    width: z.int(),
    height: z.int(),
    durationMs: z.int(),
  })
  .openapi("SpotPhotoClip", { description: "A short clip that plays in place of the photo, muted and looped; the photo is its poster" });

export const SpotPhotoSchema = z
  .object({
    id: z.string(),
    key: z.string(),
    width: z.int(),
    height: z.int(),
    thumbhash: z.string(),
    credit: z.string().nullable().openapi({ description: "Who took it: the photographer named by the submitter, else the uploader's name; null if unknown" }),
    position: z.int(),
    createdAt: z.iso.datetime().openapi({ description: "When it was added to the spot" }),
    clip: SpotPhotoClipSchema.optional(),
  })
  .openapi("SpotPhoto");

export const VideoProviderSchema = z.enum(VIDEO_PROVIDERS).openapi("VideoProvider");

export const videoClipFields = {
  id: z.string(),
  spotId: z.string(),
  provider: VideoProviderSchema,
  externalId: z.string().openapi({ description: "YouTube's video id or Instagram's shortcode" }),
  url: z.string().openapi({ description: "The normalised link; open it in the platform's app or the browser" }),
  startSeconds: z.int().nullable().openapi({ description: "YouTube only: where the clip starts" }),
  thumbnailUrl: z.string().nullable().openapi({ description: "YouTube only; Instagram has no thumbnail without an API key" }),
  caption: z.string(),
  createdAt: z.iso.datetime(),
};

export const SpotVideoSchema = z
  .object({
    ...videoClipFields,
    addedBy: z.object({ id: z.string(), name: z.string() }).nullable().openapi({ description: "Null when unknown, or for a viewer who blocked them" }),
  })
  .openapi("SpotVideo");

const voteValue = z.int().min(-1).max(1);

export const SpotVotesSchema = z
  .object({
    up: z.int().min(0),
    down: z.int().min(0),
    mine: voteValue.openapi({ description: "The viewer's own vote: 1 up, -1 down, 0 none" }),
  })
  .openapi("SpotVotes");

export const SpotScoreSchema = z
  .object({
    spotId: z.string(),
    up: z.int().min(0),
    down: z.int().min(0),
    score: z.number().min(0).max(1).openapi({
      description:
        "The Spot Score on 0…1 (× 100 is the index people see): riders' votes shrunk toward a prior, saves, photos and videos, recent activity, scaled by condition. Rank by it, highest first",
    }),
  })
  .openapi("SpotScore");

export const SpotScoresSchema = z
  .object({
    items: z.array(SpotScoreSchema).openapi({ description: "Every published public spot" }),
  })
  .openapi("SpotScores");

export const SpotVoteDraftSchema = z
  .object({ value: voteValue.openapi({ description: "1 votes the spot up, -1 down, 0 clears the vote" }) })
  .openapi("SpotVoteDraft");

export const SpotDetailSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    kind: SpotKindSchema,
    condition: SpotConditionSchema,
    visibility: SpotVisibilitySchema,
    obstacles: z.array(z.string()),
    cityId: z.string().nullable(),
    latitude,
    longitude,
    version: z.int(),
    photos: z.array(SpotPhotoSchema).openapi({ description: "In display order; the first is the cover" }),
    addedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
    videos: z.array(SpotVideoSchema).openapi({ description: "Approved YouTube and Instagram videos of the spot, oldest first" }),
    votes: SpotVotesSchema,
    createdAt: z.iso.datetime(),
  })
  .openapi("SpotDetail");

export const SpotDetailsSchema = z
  .object({
    spots: z.array(SpotDetailSchema),
    missing: z.array(z.string()).openapi({ description: "Requested ids that are not published spots you can see; stop asking for them" }),
  })
  .openapi("SpotDetails");

export const NearbySpotSchema = z
  .object({ id: z.string(), title: z.string(), kind: SpotKindSchema, latitude, longitude, distanceMeters: z.int() })
  .openapi("NearbySpot");

export const CitySchema = z
  .object({
    id: z.string(),
    slug: z.string(),
    name: z.string().openapi({ description: "In English; what to show in a language `names` doesn't have" }),
    names: z.record(z.string(), z.string()).openapi({
      description: `The name in each of the apps' languages (${CITY_LANGUAGES.join(", ")}), so an app picks its own offline; empty for a city whose names aren't filled yet`,
      example: { de: "Sankt Petersburg", ru: "Санкт-Петербург", "zh-Hans": "圣彼得堡" },
    }),
    countryCode: z.string(),
    bounds: z.object({ minLatitude: latitude, minLongitude: longitude, maxLatitude: latitude, maxLongitude: longitude }),
  })
  .openapi("City");

export const CityNameSchema = CitySchema.pick({ id: true, name: true, names: true }).openapi("CityName");

export const CITY_BOUNDARIES_LICENSE = {
  license: "ODbL-1.0",
  licenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
  attribution: "© OpenStreetMap contributors",
  attributionUrl: "https://www.openstreetmap.org/copyright",
} as const;

const PositionSchema = z.tuple([longitude, latitude]).openapi({ description: "[longitude, latitude], WGS 84" });

export const CityBoundarySchema = z
  .object({
    type: z.literal("Feature"),
    geometry: z.object({
      type: z.literal("MultiPolygon"),
      coordinates: z.array(z.array(z.array(PositionSchema))).openapi({
        description: "Polygons, each its outer ring (counterclockwise) then its holes (clockwise), rounded to 6 decimals (RFC 7946)",
      }),
    }),
    properties: CitySchema.pick({ id: true, slug: true, name: true, names: true, countryCode: true }).extend({
      wikidataId: z.string().nullable().openapi({ description: "The Wikidata item its names come from" }),
      source: z.enum(["openstreetmap", "hand-drawn"]).openapi({
        description: "openstreetmap: made from an OpenStreetMap place (its boundary minus the cities around it); hand-drawn: drawn by us",
      }),
    }),
  })
  .openapi("CityBoundary");

export const CityBoundariesSchema = z
  .object({
    type: z.literal("FeatureCollection"),
    license: z.literal(CITY_BOUNDARIES_LICENSE.license),
    licenseUrl: z.literal(CITY_BOUNDARIES_LICENSE.licenseUrl),
    attribution: z.literal(CITY_BOUNDARIES_LICENSE.attribution),
    attributionUrl: z.literal(CITY_BOUNDARIES_LICENSE.attributionUrl),
    generatedAt: z.iso.datetime(),
    features: z.array(CityBoundarySchema).openapi({ description: "Every city, shown in the apps or not yet, by slug" }),
  })
  .openapi("CityBoundaries");

export type SpotIndexRow = z.infer<typeof SpotIndexRowSchema>;
export type SyncPage = z.infer<typeof SyncPageSchema>;
export type SpotDetails = z.infer<typeof SpotDetailsSchema>;
export type NearbySpot = z.infer<typeof NearbySpotSchema>;
export type City = z.infer<typeof CitySchema>;
export type CityBoundaries = z.infer<typeof CityBoundariesSchema>;
export type CityBoundary = z.infer<typeof CityBoundarySchema>;
export type SpotVideo = z.infer<typeof SpotVideoSchema>;
export type SpotVotes = z.infer<typeof SpotVotesSchema>;
export type SpotScores = z.infer<typeof SpotScoresSchema>;

export type SpotCard = z.infer<typeof SpotCardSchema>;

export const ReviewerRoleSchema = z.enum(["curator", "owner"]).openapi("ReviewerRole", {
  description: "Why it's in your queue: curator, a city you review (or an admin); owner, a change someone suggested to a spot you added",
});
export type SpotRemoval = z.infer<typeof SpotRemovalSchema>;
export type SpotRemovalReason = z.infer<typeof SpotRemovalReasonSchema>;
