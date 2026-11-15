import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";
import { z } from "zod";
import { err, ok, type Result } from "../lib/result.ts";

const APPLE = "https://appleid.apple.com";
const appleKeys = createRemoteJWKSet(new URL(`${APPLE}/auth/keys`));

// Apple's examples send `events` as an object and `event_time` in seconds; delivered notices have carried a JSON
// string and milliseconds.
const EventSchema = z.object({
  type: z.string().min(1),
  sub: z.string().min(1),
  event_time: z.number().positive(),
});
const EventsClaimSchema = z.union([
  EventSchema,
  z
    .string()
    .transform((text, context) => {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        context.addIssue({ code: "custom", message: "events isn't JSON" });
        return z.NEVER;
      }
    })
    .pipe(EventSchema),
]);

export interface AppleAccountEvent {
  /** `consent-revoked`, `account-delete` / `account-deleted`, `email-enabled`, `email-disabled`, or one Apple adds later. */
  readonly type: string;
  /** Apple's user id, Better Auth's `account.account_id` for the `apple` provider. */
  readonly appleUserId: string;
  readonly at: Date;
}

export async function verifyAppleNotification(
  payload: string,
  audience: readonly string[],
  keys: JWTVerifyGetKey = appleKeys,
): Promise<Result<AppleAccountEvent, string>> {
  let claims;
  try {
    ({ payload: claims } = await jwtVerify(payload, keys, { issuer: APPLE, audience: [...audience], algorithms: ["RS256"] }));
  } catch (error) {
    return err(`The notice isn't signed by Apple for our apps: ${error instanceof Error ? error.name : "unknown"}`);
  }
  const events = EventsClaimSchema.safeParse(claims.events);
  if (!events.success) return err("The notice has no readable event");
  const { type, sub, event_time: time } = events.data;
  return ok({ type, appleUserId: sub, at: new Date(time > 1e12 ? time : time * 1000) });
}
