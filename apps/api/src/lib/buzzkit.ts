import { z } from "zod";
import { errorSummary } from "./log.ts";

// The app identifies its own subscriber: BuzzKit's server-side identify would replace its attributes wholesale.
const PushEnvSchema = z.object({
  BUZZKIT_API_URL: z.url(),
  BUZZKIT_API_KEY: z.string().startsWith("bk_ws_"),
  BUZZKIT_IDENTITY_SECRET: z.string().min(16),
});

export interface PushSettings {
  readonly apiUrl: string;
  readonly apiKey: string;
  readonly identitySecret: string;
}

export function parsePushSettings(env: unknown): PushSettings | undefined {
  const parsed = PushEnvSchema.safeParse(env);
  if (!parsed.success) return undefined;
  return { apiUrl: parsed.data.BUZZKIT_API_URL, apiKey: parsed.data.BUZZKIT_API_KEY, identitySecret: parsed.data.BUZZKIT_IDENTITY_SECRET };
}

const encoder = new TextEncoder();

export async function signPushIdentity(userId: string, identitySecret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(identitySecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(userId)));
  return signature.toHex();
}

export const PUSH_TOPICS = {
  reviewResults: "review-results",
  reviewQueue: "review-queue",
  spotChanges: "spot-changes",
  collectionInvites: "collection-invites",
  newSpots: "new-spots",
} as const;

export type PushTopic = (typeof PUSH_TOPICS)[keyof typeof PUSH_TOPICS];

export type PushDestination = { readonly deepLink: string } | { readonly action: { readonly name: "open_contribute" | "open_review_queue" } };

export interface PushMessage {
  readonly audience: { readonly to: readonly string[] } | { readonly where: Readonly<Record<string, unknown>> };
  readonly topic: PushTopic;
  readonly title: string;
  readonly body: string;
  readonly destination?: PushDestination;
  readonly idempotencyKey: string;
  readonly ttlSeconds?: number;
}

const TIMEOUT_MS = 10_000;
// Longer than this and the retry would outlive `waitUntil`'s 30 seconds after the response.
const MAX_RETRY_WAIT_MS = 10_000;

/** `Retry-After` as seconds or an HTTP date, in ms from now. */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (header === null || header.trim() === "") return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

export async function removePushSubscriber(settings: PushSettings, userId: string, fetcher: typeof fetch = fetch): Promise<void> {
  try {
    const response = await fetcher(new URL(`/v1/subscribers/${encodeURIComponent(userId)}`, settings.apiUrl), {
      method: "DELETE",
      headers: { authorization: `Bearer ${settings.apiKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await response.body?.cancel();
    if (!response.ok && response.status !== 404) console.error("Push subscriber not deleted", { status: response.status });
  } catch (error) {
    console.error("Push subscriber not deleted", errorSummary(error));
  }
}

const EnvelopeSchema = z.object({ success: z.boolean(), error: z.object({ code: z.string() }).nullable().optional() });

export async function sendPush(settings: PushSettings, message: PushMessage, fetcher: typeof fetch = fetch): Promise<void> {
  if ("to" in message.audience && message.audience.to.length === 0) return;
  const body = {
    ...("to" in message.audience ? { to: message.audience.to.slice(0, 1000) } : { where: message.audience.where }),
    topic: message.topic,
    title: message.title,
    body: message.body,
    ...message.destination,
    ...(message.ttlSeconds === undefined ? {} : { ttlSeconds: message.ttlSeconds }),
  };
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetcher(new URL("/v1/messages", settings.apiUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${settings.apiKey}`,
          "content-type": "application/json",
          "idempotency-key": message.idempotencyKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.ok) {
        await response.body?.cancel();
        return;
      }
      const envelope = EnvelopeSchema.safeParse(await response.json().catch(() => undefined));
      const code = envelope.success ? envelope.data.error?.code : undefined;
      if (response.status !== 429 && response.status < 500) {
        // A reused key with a changed body (a resent submission) is the guard working: it was sent the first time.
        if (code !== "idempotency_key_reused") console.error("Push not sent", { topic: message.topic, status: response.status, code });
        return;
      }
      const wait = response.status === 429 ? (retryAfterMs(response.headers.get("retry-after")) ?? 1000) : 0;
      if (attempt === 2 || wait > MAX_RETRY_WAIT_MS) {
        console.error("Push not sent", { topic: message.topic, status: response.status, code });
        return;
      }
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    } catch (error) {
      if (attempt === 2) console.error("Push not sent", { topic: message.topic, ...errorSummary(error) });
    }
  }
}

/** A few at a time: a Worker keeps at most six connections open at once. */
export async function sendPushes(settings: PushSettings, messages: readonly PushMessage[], fetcher: typeof fetch = fetch, concurrency = 4): Promise<void> {
  const queue = [...messages];
  const worker = async () => {
    for (let message = queue.shift(); message !== undefined; message = queue.shift()) await sendPush(settings, message, fetcher);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
}
