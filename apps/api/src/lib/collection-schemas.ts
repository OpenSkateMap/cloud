import { z } from "@hono/zod-openapi";
import { COLLECTION_COLORS, COLLECTION_KINDS, COLLECTION_PATTERNS, COLLECTION_ROLES, COLLECTION_VISIBILITIES } from "@openskatemap/db/schema";
import { pageOf } from "./paging.ts";
import { UsernameSchema } from "./people-schemas.ts";
import { SpotCoverSchema, SpotIndexRowSchema } from "./spot-schemas.ts";
import { UploadedPhotoRefSchema } from "./submission-schemas.ts";

export const CollectionVisibilitySchema = z
  .enum(COLLECTION_VISIBILITIES)
  .openapi("CollectionVisibility", { description: "private: the owner and the people they add. public: anyone signed in with the link" });

export const CollectionMemberRoleSchema = z.enum(COLLECTION_ROLES).openapi("CollectionMemberRole", {
  description: "viewer: sees and shares it; editor: also its name, description and spots; admin: also its people and visibility, and deleting it",
});

export type CollectionMemberRole = z.infer<typeof CollectionMemberRoleSchema>;

export const CollectionRoleSchema = z
  .enum(["owner", ...COLLECTION_ROLES, "guest"])
  .openapi("CollectionRole", { description: "Yours in it: the owner, a member's role, or guest (a public collection you aren't in)" });

export const CollectionKindSchema = z
  .enum(COLLECTION_KINDS)
  .openapi("CollectionKind", { description: "favorites: the one every account has for starred spots; it keeps its name and can't be deleted" });

// No description: on an optional reference it makes generated clients wrap the value.
export const CollectionColorSchema = z.enum(COLLECTION_COLORS).openapi("CollectionColor");

export const CollectionPatternSchema = z
  .enum(COLLECTION_PATTERNS)
  .openapi("CollectionPattern", { description: "The icon scattered behind the collection's picture" });

export const CollectionAppearanceSchema = z
  .object({
    color: CollectionColorSchema.openapi({ description: "Picked from the id until someone chooses one" }),
    pattern: CollectionPatternSchema.optional(),
    photo: z
      .object({ id: z.string(), key: z.string(), thumbhash: z.string() })
      .optional()
      .openapi({ description: "Without one, apps show the newest spot's cover; send its id back to keep it" }),
  })
  .openapi("CollectionAppearance");

export const CollectionAppearanceDraftSchema = z
  .object({
    color: CollectionColorSchema.optional(),
    pattern: CollectionPatternSchema.optional(),
    photo: UploadedPhotoRefSchema.optional(),
  })
  .openapi("CollectionAppearanceDraft", { description: "Replaces the whole look: what's left out goes back to the default (no pattern, no photo)" });

export type CollectionAppearanceDraft = z.infer<typeof CollectionAppearanceDraftSchema>;

export const CollectionOwnerSchema = z
  .object({ id: z.string(), name: z.string(), username: z.string().nullable() })
  .openapi("CollectionOwner");

export const CollectionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    visibility: CollectionVisibilitySchema,
    kind: CollectionKindSchema,
    appearance: CollectionAppearanceSchema,
    role: CollectionRoleSchema,
    owner: CollectionOwnerSchema,
    spotIds: z.array(z.string()).openapi({ description: "Its published spots you can see, most recently added first" }),
    memberCount: z.int().min(0).openapi({ description: "People added to it, not counting the owner" }),
    // No description: on a nullable reference it would make generated clients wrap the value.
    cover: SpotCoverSchema.nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi("Collection");

export type Collection = z.infer<typeof CollectionSchema>;

const CollectionPersonSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    username: z.string().nullable(),
    avatar: z.object({ key: z.string(), thumbhash: z.string() }).nullable(),
  })
  .openapi("CollectionPerson");

export const CollectionInvitationSchema = z
  .object({
    collectionId: z.string(),
    name: z.string(),
    owner: CollectionOwnerSchema,
    role: CollectionMemberRoleSchema,
    invitedBy: CollectionOwnerSchema.nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi("CollectionInvitation", { description: "Someone invited you to their collection; you see it once you accept" });

export const CollectionsSnapshotSchema = z
  .object({
    collections: z.array(CollectionSchema).openapi({ description: "Yours first, then the ones shared with you, newest first" }),
    invitations: z.array(CollectionInvitationSchema).openapi({ description: "Waiting for your answer, newest first" }),
    requestedIds: z.array(z.string()).openapi({ description: "Collections you asked to join, still waiting for an answer" }),
    privateSpots: z.array(SpotIndexRowSchema).openapi({
      description: "Every private spot you made or can see through these collections; drop local private spots that aren't here",
    }),
  })
  .openapi("CollectionsSnapshot");

export type CollectionsSnapshot = z.infer<typeof CollectionsSnapshotSchema>;

export const CollectionSpotsPageSchema = pageOf(SpotIndexRowSchema, "CollectionSpotsPage");

export type CollectionSpotsPage = z.infer<typeof CollectionSpotsPageSchema>;

export const CollectionPageSchema = z
  .object({
    collection: CollectionSchema,
    spots: z.array(SpotIndexRowSchema).openapi({ description: "The first page of its spots, in `spotIds` order" }),
    nextCursor: z
      .string()
      .nullable()
      .openapi({ description: "More spots: `GET /v1/collections/{collectionId}/spots?cursor=` with this; null when `spots` is all of them" }),
  })
  .openapi("CollectionPage");

export type CollectionPage = z.infer<typeof CollectionPageSchema>;

export const CollectionDraftSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    description: z.string().trim().max(300).default(""),
    visibility: CollectionVisibilitySchema.default("private"),
    appearance: CollectionAppearanceDraftSchema.optional().openapi({ description: "Left out: the look stays as it is" }),
  })
  .openapi("CollectionDraft", { description: "Creates the collection under the app's id, or changes yours" });

export type CollectionDraft = z.infer<typeof CollectionDraftSchema>;

export const CollectionMemberSchema = z
  .object({ user: CollectionPersonSchema, role: CollectionMemberRoleSchema, addedAt: z.iso.datetime() })
  .openapi("CollectionMember");

export const CollectionInviteSchema = z
  .object({
    id: z.string(),
    email: z.string().nullable().openapi({ description: "As it was typed, for an invite by email" }),
    user: CollectionPersonSchema.nullable().openapi({ description: "Who it's for: from the start by @username, once their account opens the app by email" }),
    role: CollectionMemberRoleSchema,
    createdAt: z.iso.datetime(),
  })
  .openapi("CollectionInvite", { description: "Waiting for the person to accept" });

export const CollectionRequestSchema = z
  .object({ user: CollectionPersonSchema, createdAt: z.iso.datetime() })
  .openapi("CollectionRequest", { description: "Someone with the link asking to join" });

export const CollectionAccessSchema = z
  .object({
    visibility: CollectionVisibilitySchema,
    owner: CollectionPersonSchema,
    members: z.array(CollectionMemberSchema).openapi({ description: "Most recently added first" }),
    invites: z.array(CollectionInviteSchema).openapi({ description: "Newest first; only for the owner and admins, empty for everyone else" }),
    requests: z.array(CollectionRequestSchema).openapi({ description: "Oldest first; only for the owner and admins, empty for everyone else" }),
  })
  .openapi("CollectionAccess");

export type CollectionAccess = z.infer<typeof CollectionAccessSchema>;

export const CollectionInviteDraftSchema = z
  .object({
    username: z
      .string()
      .trim()
      .transform((value) => value.replace(/^@/, ""))
      .pipe(UsernameSchema)
      .optional()
      .openapi({ description: "Their @username; a leading @ is fine" }),
    email: z.string().trim().toLowerCase().pipe(z.email()).optional().openapi({ description: "The email they signed in with" }),
    role: CollectionMemberRoleSchema.default("viewer"),
  })
  .refine(({ username, email }) => (username === undefined) !== (email === undefined), "Send a username or an email")
  .openapi("CollectionInviteDraft");

export type CollectionInviteDraft = z.infer<typeof CollectionInviteDraftSchema>;

export const CollectionMemberDraftSchema = z.object({ role: CollectionMemberRoleSchema }).openapi("CollectionMemberDraft");

export const CollectionRequestAnswerSchema = z
  .object({ role: CollectionMemberRoleSchema.default("viewer") })
  .openapi("CollectionRequestAnswer", { description: "Lets them in with this role" });
