import { z } from "@hono/zod-openapi";
import { REPORT_REASONS, REPORT_TARGETS } from "@openskatemap/db/schema";
import { RoleSchema } from "../auth/roles.ts";
import { UploadedPhotoRefSchema } from "./submission-schemas.ts";

/** Kept in the case typed; uniqueness and lookups ignore case (`profile_username_lower_unique`). */
export const UsernameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_]{5,24}$/, "Use 5 to 24 English letters, digits or underscores");

const handle = (pattern: RegExp) =>
  z
    .string()
    .trim()
    .transform((value) => value.replace(/^@/, ""))
    .pipe(z.string().regex(pattern, "Not a valid handle for this network"));

const HANDLE_RULES = {
  instagram: handle(/^[A-Za-z0-9._]{1,30}$/),
  tiktok: handle(/^[A-Za-z0-9._]{2,24}$/),
  youtube: handle(/^[A-Za-z0-9._-]{3,30}$/),
  x: handle(/^[A-Za-z0-9_]{1,15}$/),
  telegram: handle(/^[A-Za-z][A-Za-z0-9_]{4,31}$/),
  website: z.url({ protocol: /^https?$/ }).max(200),
};

export const HandlesSchema = z
  .object({
    instagram: z.string().nullable(),
    tiktok: z.string().nullable(),
    youtube: z.string().nullable(),
    x: z.string().nullable(),
    telegram: z.string().nullable(),
    website: z.string().nullable(),
  })
  .openapi("Handles");

export const CLEARABLE_PROFILE_FIELDS = ["username", "bio", "avatar", "instagram", "tiktok", "youtube", "x", "telegram", "website"] as const;

export const ProfileUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(50),
    username: UsernameSchema,
    bio: z.string().trim().max(160),
    avatar: UploadedPhotoRefSchema,
    handles: z
      .object({
        instagram: HANDLE_RULES.instagram,
        tiktok: HANDLE_RULES.tiktok,
        youtube: HANDLE_RULES.youtube,
        x: HANDLE_RULES.x,
        telegram: HANDLE_RULES.telegram,
        website: HANDLE_RULES.website,
      })
      .partial(),
    clear: z
      .array(z.enum(CLEARABLE_PROFILE_FIELDS).openapi("ClearableProfileField"))
      .max(CLEARABLE_PROFILE_FIELDS.length)
      .openapi({ description: "Fields to empty" }),
  })
  .partial()
  .refine(
    ({ clear = [], handles = {}, ...fields }) => clear.every((field) => !(field in fields) && !(field in handles)),
    "A field can't be both set and cleared",
  )
  .openapi("ProfileUpdate", { description: "Only the fields sent change; `clear` empties the ones named" });

export const PublicProfileSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    username: z.string().nullable(),
    bio: z.string(),
    avatar: z.object({ key: z.string(), thumbhash: z.string() }).nullable(),
    handles: HandlesSchema,
    role: RoleSchema,
    editorOf: z.array(z.object({ id: z.string(), name: z.string() })).openapi({ description: "Cities this person reviews" }),
    stats: z.object({
      submitted: z.int(),
      approved: z.int(),
      cities: z.int().openapi({ description: "Cities with at least one approved spot from this person" }),
    }),
    joinedAt: z.iso.datetime(),
    blockedByMe: z.boolean(),
  })
  .openapi("PublicProfile");

export const ReportInputSchema = z
  .object({
    targetKind: z.enum(REPORT_TARGETS),
    targetId: z.string().min(1).max(64),
    reason: z.enum(REPORT_REASONS).openapi("ReportReason"),
    message: z.string().trim().max(500).default(""),
  })
  .openapi("ReportInput");

export const BlockedUserSchema = z
  .object({ id: z.string(), name: z.string(), username: z.string().nullable(), blockedAt: z.iso.datetime() })
  .openapi("BlockedUser");

export type ProfileUpdate = z.infer<typeof ProfileUpdateSchema>;
export type ClearableProfileField = (typeof CLEARABLE_PROFILE_FIELDS)[number];
export type PublicProfile = z.infer<typeof PublicProfileSchema>;
export type ReportInput = z.infer<typeof ReportInputSchema>;
export type BlockedUser = z.infer<typeof BlockedUserSchema>;
