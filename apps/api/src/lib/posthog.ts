import type { REPORT_TARGETS, SPOT_REMOVAL_REASONS, VIDEO_PROVIDERS } from "@openskatemap/db/schema";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env.ts";
import type { CollectionMemberRole } from "./collection-schemas.ts";
import { errorSummary } from "./log.ts";

// Keyed by the account id. The app sends screens and intent; the Worker only the outcomes it alone knows for sure.

/** Properties are never free text, names or emails. */
export interface ServerEvents {
  spot_submitted: { private: boolean; photos: number };
  edit_suggested: { photos: number };
  spot_edited: { photos: number };
  video_submitted: { provider: (typeof VIDEO_PROVIDERS)[number] };
  submission_reviewed: { target: "spot" | "edit" | "video"; decision: "approved" | "rejected" | "undone" };
  spot_voted: { value: number };
  spot_removed: { private: boolean; reason: (typeof SPOT_REMOVAL_REASONS)[number] };
  spot_restored: { private: boolean };
  collection_shared: { via: "username" | "email"; role: CollectionMemberRole };
  collection_access_requested: Record<string, never>;
  collection_joined: Record<string, never>;
  collection_request_approved: { role: CollectionMemberRole };
  report_sent: { target: (typeof REPORT_TARGETS)[number] };
}

const CaptureEnvSchema = z.object({ POSTHOG_PROJECT_TOKEN: z.string().startsWith("phc_") });

const PersonsEnvSchema = z.object({
  POSTHOG_PROJECT_ID: z.string().regex(/^\d+$/),
  POSTHOG_PERSONAL_API_KEY: z.string().startsWith("phx_"),
});

/** `once` names the business event, so the outbox's retries count once. */
export function track<E extends keyof ServerEvents>(c: Context<AppEnv>, event: E, properties: ServerEvents[E], once?: string): void {
  const token = captureToken(c.env, c.req.raw.headers);
  if (token) c.executionCtx.waitUntil(capture(token, event, c.var.user.id, { ...properties, ...located(c.req.raw.headers) }, once));
}

/** PostHog finds the area from `$ip`; without it, the Worker's own address would place everyone at a Cloudflare data center. */
export function located(headers: Headers): { $ip: string } | { $geoip_disable: true } {
  const address = headers.get("cf-connecting-ip");
  return address ? { $ip: address } : { $geoip_disable: true };
}

/** The app sends `DNT: 1` while Share Analytics is off. */
export function captureToken(env: unknown, headers: Headers): string | undefined {
  const parsed = CaptureEnvSchema.safeParse(env);
  return parsed.success && headers.get("dnt") !== "1" ? parsed.data.POSTHOG_PROJECT_TOKEN : undefined;
}

export async function capture(
  token: string,
  event: string,
  distinctId: string,
  properties: Readonly<Record<string, unknown>>,
  once?: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  try {
    const response = await fetcher("https://us.i.posthog.com/i/v0/e/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: token,
        event,
        distinct_id: distinctId,
        properties: { ...properties, $lib: "openskatemap-api" },
        timestamp: new Date().toISOString(),
        ...(once === undefined ? {} : { uuid: await eventUuid(`${event}:${once}`) }),
      }),
    });
    await response.body?.cancel();
    if (!response.ok) console.warn("PostHog refused an event", { status: response.status });
  } catch (error) {
    console.warn("PostHog unreachable", errorSummary(error));
  }
}

/** The same key always gives the same UUID, which PostHog deduplicates on. */
export async function eventUuid(key: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key))).slice(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toHex();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface PersonsSettings {
  readonly projectId: string;
  readonly apiKey: string;
}

export function parsePersonsSettings(env: unknown): PersonsSettings | undefined {
  const parsed = PersonsEnvSchema.safeParse(env);
  if (!parsed.success) return undefined;
  return { projectId: parsed.data.POSTHOG_PROJECT_ID, apiKey: parsed.data.POSTHOG_PERSONAL_API_KEY };
}

export async function deletePerson(settings: PersonsSettings, userId: string, fetcher: typeof fetch = fetch): Promise<void> {
  try {
    const response = await fetcher(`https://us.posthog.com/api/projects/${settings.projectId}/persons/bulk_delete/`, {
      method: "POST",
      headers: { authorization: `Bearer ${settings.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ distinct_ids: [userId], delete_events: true }),
    });
    await response.body?.cancel();
    if (!response.ok) console.error("Analytics person not deleted", { status: response.status });
  } catch (error) {
    console.error("Analytics person not deleted", errorSummary(error));
  }
}
