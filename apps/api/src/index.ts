import type { Database } from "@openskatemap/db";
import { createApp } from "./app.ts";
import { parsePushSettings, type PushMessage, sendPushes } from "./lib/buzzkit.ts";
import { onDatabase } from "./lib/on-database.ts";
import { SCHEDULES } from "./schedules.ts";
import { newSpotsDigest, reviewEscalations } from "./services/notifications.ts";
import { eraseElsewhere } from "./services/account.ts";
import { deleteDueAccounts } from "./services/apple-account-events.ts";
import { deleteSweptUploads, sweep } from "./services/housekeeping.ts";
import { refreshSpotScores } from "./services/spot-score.ts";

const app = createApp();

async function pushJob(env: Env, label: string, compose: (db: Database) => Promise<PushMessage[]>) {
  const push = parsePushSettings(env);
  if (!push) return;
  const notices = await onDatabase(env, label, compose);
  if (notices) await sendPushes(push, notices);
}

export default {
  fetch: app.fetch,
  async scheduled(controller, env) {
    const now = new Date(controller.scheduledTime);
    switch (controller.cron) {
      case SCHEDULES.spotScores:
        await onDatabase(env, "Spot scores refresh", refreshSpotScores);
        return;
      case SCHEDULES.housekeeping: {
        const swept = await onDatabase(env, "Housekeeping", (db) => sweep(db, now));
        if (swept) await deleteSweptUploads(env.PHOTOS, swept);
        const deleted = await onDatabase(env, "Apple account deletions", (db) => deleteDueAccounts(db, env.PHOTOS, now));
        await Promise.all((deleted ?? []).flatMap((userId) => eraseElsewhere(env, userId)));
        return;
      }
      case SCHEDULES.newSpotsDigest:
        return pushJob(env, "New spots digest", (db) => newSpotsDigest(db, now));
      case SCHEDULES.reviewEscalations:
        return pushJob(env, "Review escalations", (db) => reviewEscalations(db, now));
    }
  },
} satisfies ExportedHandler<Env>;
