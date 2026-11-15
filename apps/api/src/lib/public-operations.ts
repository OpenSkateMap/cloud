// Deny by default (test/contract.test.ts). Adding an operation is a security decision: say why next to it.
export const PUBLIC_OPERATIONS = new Set([
  // Liveness only; reveals nothing but "ok".
  "getHealth",
  // Exchanges an Apple identity token for a session; AUTH_LIMITER caps it per address.
  "signInWithApple",
  // Apple's notices that someone stopped using Sign in with Apple for us; only a JWT Apple signed for our apps counts.
  "receiveAppleNotification",
  // A shared spot link's preview: name, kind, city and cover only (`SpotCardSchema` is strict).
  "getSpotCard",
]);
