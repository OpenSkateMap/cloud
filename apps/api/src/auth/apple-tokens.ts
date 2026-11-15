import { decodeJwt, SignJWT } from "jose";
import { z } from "zod";
import { err, ok, type Result } from "../lib/result.ts";

const APPLE = "https://appleid.apple.com";

export interface AppleSigningKey {
  readonly teamId: string;
  readonly keyId: string;
  readonly privateKey: string;
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export async function appleClientSecret(key: AppleSigningKey, clientId: string, now = Date.now()): Promise<string> {
  const issuedAt = Math.floor(now / 1000);
  const signingKey = await crypto.subtle.importKey("pkcs8", Uint8Array.fromBase64(key.privateKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return new SignJWT()
    .setProtectedHeader({ alg: "ES256", kid: key.keyId, typ: "JWT" })
    .setIssuer(key.teamId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 300)
    .setAudience(APPLE)
    .setSubject(clientId)
    .sign(signingKey);
}

const TokenResponse = z.object({ refresh_token: z.string().min(1) });

// Never throws: sign-in and account deletion carry on (and log) when Apple can't be reached.
async function post(fetcher: Fetch, path: string, form: Record<string, string>): Promise<Result<unknown, string>> {
  try {
    const response = await fetcher(`${APPLE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return err(`Apple answered ${response.status} to ${path}`);
    return ok(await response.json().catch(() => null));
  } catch (error) {
    return err(`Apple's ${path} failed: ${error instanceof Error ? error.name : "unknown"}`);
  }
}

export async function exchangeAuthorizationCode(key: AppleSigningKey, clientId: string, code: string, fetcher: Fetch = fetch): Promise<Result<string, string>> {
  const response = await post(fetcher, "/auth/token", {
    client_id: clientId,
    client_secret: await appleClientSecret(key, clientId),
    code,
    grant_type: "authorization_code",
  });
  if (response.isErr()) return err(response.error);
  const parsed = TokenResponse.safeParse(response.value);
  return parsed.success ? ok(parsed.data.refresh_token) : err("Apple's token response had no refresh token");
}

export async function revokeRefreshToken(key: AppleSigningKey, clientId: string, refreshToken: string, fetcher: Fetch = fetch): Promise<Result<void, string>> {
  const response = await post(fetcher, "/auth/revoke", {
    client_id: clientId,
    client_secret: await appleClientSecret(key, clientId),
    token: refreshToken,
    token_type_hint: "refresh_token",
  });
  return response.isErr() ? err(response.error) : ok(undefined);
}

export function identityTokenAudience(idToken: string): string | undefined {
  let claims: unknown;
  try {
    claims = decodeJwt(idToken);
  } catch {
    return undefined;
  }
  const parsed = z.object({ aud: z.union([z.string(), z.array(z.string()).nonempty()]) }).safeParse(claims);
  if (!parsed.success) return undefined;
  return typeof parsed.data.aud === "string" ? parsed.data.aud : parsed.data.aud[0];
}
