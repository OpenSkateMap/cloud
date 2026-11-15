import { z } from "zod";
import type { AppleSigningKey } from "../auth/apple-tokens.ts";
import type { AuthSettings } from "../auth/create-auth.ts";

const bundleId = z.string().regex(/^[A-Za-z0-9.-]+$/);

const AuthEnvSchema = z.object({
  API_ORIGIN: z.url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  APPLE_BUNDLE_IDS: z
    .string()
    .transform((value) => value.split(",").map((id) => id.trim()))
    .pipe(z.tuple([bundleId], bundleId)),
});

export function parseAuthSettings(env: unknown): AuthSettings | undefined {
  const parsed = AuthEnvSchema.safeParse(env);
  if (!parsed.success) return undefined;
  return {
    apiOrigin: parsed.data.API_ORIGIN,
    secret: parsed.data.BETTER_AUTH_SECRET,
    appleBundleIds: parsed.data.APPLE_BUNDLE_IDS,
  };
}

export interface AppleTokenSettings {
  readonly key: AppleSigningKey;
  readonly secret: string;
  readonly bundleIds: readonly string[];
}

const appleId = z.string().regex(/^[A-Z0-9]{10}$/);
const AppleTokenEnvSchema = z.object({
  APPLE_TEAM_ID: appleId,
  APPLE_SIGN_IN_KEY_ID: appleId,
  APPLE_SIGN_IN_KEY: z.base64().min(100),
  BETTER_AUTH_SECRET: z.string().min(32),
  APPLE_BUNDLE_IDS: AuthEnvSchema.shape.APPLE_BUNDLE_IDS,
});

export function parseAppleTokenSettings(env: unknown): AppleTokenSettings | undefined {
  const parsed = AppleTokenEnvSchema.safeParse(env);
  if (!parsed.success) return undefined;
  return {
    key: { teamId: parsed.data.APPLE_TEAM_ID, keyId: parsed.data.APPLE_SIGN_IN_KEY_ID, privateKey: parsed.data.APPLE_SIGN_IN_KEY },
    secret: parsed.data.BETTER_AUTH_SECRET,
    bundleIds: parsed.data.APPLE_BUNDLE_IDS,
  };
}
