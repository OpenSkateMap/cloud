import { z } from "@hono/zod-openapi";
import { REJECT_REASONS, SPOT_EDIT_FIELDS, SUBMISSION_KINDS, SUBMISSION_STATUSES } from "@openskatemap/db/schema";
import { IdSchema, NearbySpotSchema, ReviewerRoleSchema, SpotConditionSchema, SpotKindSchema, SpotRemovalSchema } from "./spot-schemas.ts";
import { VideoReviewCardSchema } from "./video-schemas.ts";

const latitude = z.number().min(-90).max(90);
const longitude = z.number().min(-180).max(180);
const title = z.string().trim().min(1).max(120);
const description = z.string().trim().max(2000);
const obstacles = z.array(z.string().trim().toLowerCase().min(1).max(40)).max(12);
const thumbhash = z.base64().min(4).max(48).openapi({ description: "ThumbHash of the photo, base64" });

export const PhotoCreditSchema = z
  .discriminatedUnion("takenBy", [
    z.object({ takenBy: z.literal("submitter") }).openapi("SubmitterPhotoCredit"),
    z
      .object({
        takenBy: z.literal("someone_else"),
        credit: z.string().trim().min(1).max(80).openapi({ description: "A photographer's name or handle, shown on the spot" }),
        hasPermission: z.literal(true).openapi({ description: "The submitter has permission to use the photo" }),
        sourceUrl: z.url({ protocol: /^https?$/ }).max(500).optional(),
      })
      .openapi("OtherPhotoCredit"),
  ])
  .openapi("PhotoCredit");

export type PhotoCredit = z.infer<typeof PhotoCreditSchema>;

// Edits before full photo lists could add photos past New Spot's ten.
const MAX_SPOT_PHOTOS = 30;

export const UploadedPhotoRefSchema = z.object({ photoId: z.uuid(), thumbhash });
const DraftPhotoSchema = UploadedPhotoRefSchema.extend({ credit: PhotoCreditSchema });
const distinctIds = (ids: string[]) => new Set(ids).size === ids.length;
const distinctPhotos = (photos: { photoId: string }[]) => distinctIds(photos.map((photo) => photo.photoId));
const bothOrNeither = (place: { latitude?: number | undefined; longitude?: number | undefined }) => (place.latitude === undefined) === (place.longitude === undefined);
const note = z.string().trim().max(500).default("").openapi({ description: "For the curator; never shown on the spot" });

export const PhotoUploadSchema = z
  .object({
    id: z.string(),
    width: z.int().openapi({ description: "Measured by the server" }),
    height: z.int(),
    bytes: z.int().openapi({ description: "Stored size, after metadata was removed" }),
  })
  .openapi("PhotoUpload");

export const NewSpotDraftSchema = z
  .object({
    kind: z.literal("new_spot"),
    title,
    description: description.default(""),
    spotKind: SpotKindSchema,
    obstacles: obstacles.default([]),
    condition: SpotConditionSchema.default("skateable"),
    latitude,
    longitude,
    note,
    collectionId: IdSchema.optional().openapi({
      description: "One of your private collections: the spot is private, published into it at once and never reviewed",
    }),
    photos: z
      .array(DraftPhotoSchema)
      .max(10)
      .refine(distinctPhotos, "Each photo may appear once")
      .openapi({ description: "In display order; the first is the cover. May be empty: the spot shows its kind until a photo is added" }),
  })
  .openapi("NewSpotDraft");

export type NewSpotDraft = z.infer<typeof NewSpotDraftSchema>;

export const SpotFieldSchema = z.enum(SPOT_EDIT_FIELDS).openapi("SpotField");

const SpotPhotoEditSchema = z
  .object({
    order: z.array(z.uuid()).refine(distinctIds, "Each photo may appear once").openapi({
      description: "The spot's photos as the edit leaves them, the cover first: ids of the spot's own photos it keeps (the rest are removed) and every photo in `photos`",
    }),
    base: z
      .array(z.uuid())
      .refine(distinctIds, "Each photo may appear once")
      .openapi({ description: "The spot's photos as the editor showed them; `order` may name only these and `photos`" }),
  })
  // 1.0.1's additions can take a spot past the cap; such a spot may still shrink or reorder.
  .refine(({ order, base }) => order.length <= Math.max(MAX_SPOT_PHOTOS, base.length), `A spot keeps at most ${MAX_SPOT_PHOTOS} photos`)
  .openapi("SpotPhotoEdit", {
    description: "The spot's whole photo list as the edit leaves it; photos the spot gained after `base` stay. Without it the edit doesn't touch the order: its `photos` go after the spot's own",
  });

export const SpotEditDraftSchema = z
  .object({
    spotId: IdSchema,
    changes: z
      .object({ title, description, spotKind: SpotKindSchema, obstacles, condition: SpotConditionSchema, latitude, longitude })
      .partial()
      .refine(bothOrNeither, "Move the pin with both latitude and longitude")
      .openapi({ description: "The fields to change; values equal to the spot's are ignored" }),
    photos: z
      .array(DraftPhotoSchema)
      .max(10)
      .refine(distinctPhotos, "Each photo may appear once")
      .default([])
      .openapi({ description: "New photos, placed by `photoEdit.order`; without `photoEdit`, after the spot's own" }),
    photoEdit: SpotPhotoEditSchema.optional(),
    note,
  })
  .refine(
    (draft) => Object.keys(draft.changes).length > 0 || draft.photos.length > 0 || draft.photoEdit !== undefined,
    "Change something or the photos",
  )
  .openapi("SpotEditDraft");

export type SpotEditDraft = z.infer<typeof SpotEditDraftSchema>;

export const SubmissionPhotoSchema = z
  .object({
    photoId: z.string(),
    key: z.string(),
    width: z.int(),
    height: z.int(),
    thumbhash: z.string(),
    credit: PhotoCreditSchema,
    position: z.int(),
    existing: z.boolean().openapi({ description: "One of the edited spot's own photos, kept by the edit; its credit is the spot's" }),
  })
  .openapi("SubmissionPhoto");

export const SubmissionSchema = z
  .object({
    id: z.string(),
    kind: z.enum(SUBMISSION_KINDS),
    status: z.enum(SUBMISSION_STATUSES).openapi("SubmissionStatus"),
    title: z.string(),
    description: z.string(),
    spotKind: SpotKindSchema,
    obstacles: z.array(z.string()),
    condition: SpotConditionSchema,
    latitude,
    longitude,
    cityId: z.string().nullable(),
    note: z.string(),
    photos: z.array(SubmissionPhotoSchema),
    spotId: z.string().nullable().openapi({ description: "The spot an approval created; for an edit, the spot it changes" }),
    changedFields: z.array(SpotFieldSchema).openapi({ description: "What an edit changes; empty for a new spot" }),
    collectionId: z.string().nullable().openapi({ description: "Set for a private spot: the collection it went into" }),
    rejectReason: z.enum(REJECT_REASONS).nullable().openapi({ description: "Why a curator rejected it" }),
    removal: z.object(SpotRemovalSchema.shape).nullable().openapi({ description: "Set when an admin took its spot down: the history keeps the row and says why" }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi("Submission");

export type Submission = z.infer<typeof SubmissionSchema>;
export type PhotoUpload = z.infer<typeof PhotoUploadSchema>;

export const SpotEditsSchema = z
  .object({
    title,
    description,
    spotKind: SpotKindSchema,
    obstacles,
    condition: SpotConditionSchema,
    latitude,
    longitude,
    photoIds: z
      .array(z.uuid())
      .max(MAX_SPOT_PHOTOS)
      .refine(distinctIds, "Each photo may appear once")
      .openapi({ description: "Which of the submission's photos to publish, in order; the first is the cover. An edit's are the spot's photos as approved" }),
  })
  .partial()
  .refine(bothOrNeither, "Move the pin with both latitude and longitude")
  .openapi("SpotEdits");

export type SpotEdits = z.infer<typeof SpotEditsSchema>;

export const RejectReasonSchema = z.enum(REJECT_REASONS).openapi("RejectReason");

export const SpotSnapshotSchema = z
  .object({
    title: z.string(),
    description: z.string(),
    spotKind: SpotKindSchema,
    obstacles: z.array(z.string()),
    condition: SpotConditionSchema,
    latitude,
    longitude,
    photoCount: z.int(),
    removedPhotoCount: z.int().openapi({ description: "How many of the spot's photos the edit removes; photos it gained since stay" }),
  })
  .openapi("SpotSnapshot");

export type SpotSnapshot = z.infer<typeof SpotSnapshotSchema>;

export const ReviewCardSchema = SubmissionSchema.extend({
  submitter: z.object({ id: z.string(), name: z.string() }).nullable(),
  nearby: z.array(NearbySpotSchema).openapi({ description: "Published spots within 150 m: likely duplicates; empty for an edit" }),
  current: SpotSnapshotSchema.nullable().openapi({ description: "For an edit, the spot as it is now; null for a new spot" }),
  reviewAs: ReviewerRoleSchema,
}).openapi("ReviewCard");

export const ReviewQueueSchema = z
  .object({
    cityIds: z
      .array(z.string())
      .nullable()
      .openapi({ description: "The cities this reviewer covers; null for admins, who cover everywhere; empty for everyone else" }),
    items: z.array(ReviewCardSchema).openapi({ description: "Pending submissions in those cities, and others' edits to spots you added; oldest first" }),
    videos: z.array(VideoReviewCardSchema).openapi({ description: "Pending videos of spots in the same cities, and of spots you added, oldest first" }),
  })
  .openapi("ReviewQueue");

export type ReviewCard = z.infer<typeof ReviewCardSchema>;
export type ReviewQueue = z.infer<typeof ReviewQueueSchema>;
