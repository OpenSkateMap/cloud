// Listed again in `cloudflare.config.ts`, which can't import this; test/schedules.test.ts keeps them equal.
export const SCHEDULES = {
  newSpotsDigest: "0 17 * * SUN",
  reviewEscalations: "0 9 * * *",
  spotScores: "*/10 * * * *",
  housekeeping: "30 3 * * *",
} as const;
