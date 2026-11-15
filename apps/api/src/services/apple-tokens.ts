import type { Database } from "@openskatemap/db";
import { appleToken } from "@openskatemap/db/schema";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { exchangeAuthorizationCode, type Fetch, identityTokenAudience, revokeRefreshToken } from "../auth/apple-tokens.ts";
import type { AppleTokenSettings } from "../lib/auth-settings.ts";
import { err, ok, type Result } from "../lib/result.ts";

export async function rememberAppleToken(
  db: Database,
  settings: AppleTokenSettings,
  { userId, idToken, authorizationCode }: { userId: string; idToken: string; authorizationCode: string },
  fetcher?: Fetch,
): Promise<Result<void, string>> {
  const clientId = identityTokenAudience(idToken);
  if (!clientId || !settings.bundleIds.includes(clientId)) return err("The identity token's audience isn't one of our apps");
  const exchanged = await exchangeAuthorizationCode(settings.key, clientId, authorizationCode, fetcher);
  if (exchanged.isErr()) return err(exchanged.error);
  const refreshToken = await symmetricEncrypt({ key: settings.secret, data: exchanged.value });
  await db
    .insert(appleToken)
    .values({ userId, clientId, refreshToken })
    .onConflictDoUpdate({ target: appleToken.userId, set: { clientId, refreshToken, updatedAt: new Date() } });
  return ok(undefined);
}

export async function revokeAppleToken(db: Database, settings: AppleTokenSettings, userId: string, fetcher?: Fetch): Promise<Result<"revoked" | "none", string>> {
  const [stored] = await db.select().from(appleToken).where(eq(appleToken.userId, userId));
  if (!stored) return ok("none");
  // A rotated BETTER_AUTH_SECRET can't decrypt older tokens; deletion goes on without revoking.
  const refreshToken = await symmetricDecrypt({ key: settings.secret, data: stored.refreshToken }).catch(() => undefined);
  if (refreshToken === undefined) return err("The stored Apple token couldn't be decrypted");
  const revoked = await revokeRefreshToken(settings.key, stored.clientId, refreshToken, fetcher);
  return revoked.isErr() ? err(revoked.error) : ok("revoked");
}
