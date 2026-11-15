import { z } from "@hono/zod-openapi";
import { VIDEO_REJECT_REASONS, VIDEO_STATUSES } from "@openskatemap/db/schema";
import { ReviewerRoleSchema, SpotKindSchema, videoClipFields } from "./spot-schemas.ts";

export const VideoRejectReasonSchema = z.enum(VIDEO_REJECT_REASONS).openapi("VideoRejectReason");

const caption = z.string().trim().max(120);

export const VideoDraftSchema = z
  .object({
    url: z.string().trim().min(1).max(500).openapi({ description: "A YouTube or Instagram link, as pasted; the server normalises it" }),
    caption: caption.default("").openapi({ description: "Shown under the video, e.g. who's skating" }),
  })
  .openapi("VideoDraft");

export type VideoDraft = z.infer<typeof VideoDraftSchema>;

export const VideoSubmissionSchema = z
  .object({
    ...videoClipFields,
    status: z.enum(VIDEO_STATUSES).openapi("VideoStatus"),
    rejectReason: VideoRejectReasonSchema.nullable(),
    updatedAt: z.iso.datetime(),
  })
  .openapi("VideoSubmission");

export const VideoReviewCardSchema = VideoSubmissionSchema.extend({
  spot: z.object({ id: z.string(), title: z.string(), kind: SpotKindSchema, cityId: z.string().nullable() }),
  submitter: z.object({ id: z.string(), name: z.string() }).nullable(),
  reviewAs: ReviewerRoleSchema,
}).openapi("VideoReviewCard");

export type VideoSubmission = z.infer<typeof VideoSubmissionSchema>;
export type VideoReviewCard = z.infer<typeof VideoReviewCardSchema>;
export type VideoRejectReason = z.infer<typeof VideoRejectReasonSchema>;
