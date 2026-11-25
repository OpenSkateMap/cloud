import { TIMEOUT_CODES } from "@openskatemap/db";
import { bodyLimit } from "hono/body-limit";
import { except } from "hono/combine";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { errorSummary } from "./lib/log.ts";
import { livePlaceLookup, type PlaceLookup } from "./lib/nominatim.ts";
import { createRouter } from "./lib/openapi-app.ts";
import { respondError } from "./lib/respond.ts";
import { rateLimitByIp } from "./middleware/rate-limit.ts";
import { auth } from "./routes/auth.ts";
import { clips } from "./routes/clips.ts";
import { collections } from "./routes/collections.ts";
import { health } from "./routes/health.ts";
import { me } from "./routes/me.ts";
import { people } from "./routes/people.ts";
import { photos } from "./routes/photos.ts";
import { review } from "./routes/review.ts";
import { spotCards } from "./routes/spot-cards.ts";
import { spots } from "./routes/spots.ts";
import { submissions } from "./routes/submissions.ts";
import { videos } from "./routes/videos.ts";
import { votes } from "./routes/votes.ts";

export const openApiInfo = {
  openapi: "3.1.0" as const,
  info: {
    title: "OpenSkateMap API",
    version: "0.1.0",
    description:
      "The API behind the OpenSkateMap app. Every response is an envelope: `{ ok: true, data }` or `{ ok: false, error }`.",
  },
  servers: [{ url: "https://api.openskatemap.app" }],
};

const apiHeaders = secureHeaders({
  contentSecurityPolicy: { frameAncestors: ["'none'"] },
  xFrameOptions: "DENY",
  strictTransportSecurity: false,
});

export function createApp({ placeLookup = livePlaceLookup }: { placeLookup?: PlaceLookup | null } = {}) {
  const app = createRouter();

  const limitBody = bodyLimit({
    maxSize: 256 * 1024,
    onError: (c) => respondError(c, { code: "validation_failed", message: "The request body is too large" }),
  });
  app.use("/v1/*", apiHeaders);
  app.use("/v1/*", rateLimitByIp("ADDRESS_LIMITER"));
  app.use("/v1/*", except(["/v1/photos/*", "/v1/clips/*"], limitBody));
  app.use("/v1/*", async (c, next) => {
    c.set("placeLookup", placeLookup);
    await next();
  });

  app.route("/", health);
  app.route("/", auth);
  app.route("/", me);
  app.route("/", spots);
  app.route("/", spotCards);
  app.route("/", submissions);
  app.route("/", videos);
  app.route("/", votes);
  app.route("/", photos);
  app.route("/", clips);
  app.route("/", review);
  app.route("/", people);
  app.route("/", collections);

  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    description: "The session token the app receives from POST /v1/auth/apple",
  });

  app.doc31("/v1/openapi.json", openApiInfo);

  app.notFound((c) => respondError(c, { code: "not_found", message: `No route for ${c.req.method} ${c.req.path}` }));
  app.onError((error, c) => {
    if (error instanceof HTTPException && error.status < 500) {
      return respondError(c, { code: "validation_failed", message: error.message || "The request could not be read" });
    }
    const summary = errorSummary(error);
    if (summary.code && TIMEOUT_CODES.has(summary.code)) {
      console.error("Database timeout", summary);
      return respondError(c, { code: "unavailable", message: "The database is busy; try again" });
    }
    console.error("Unhandled error", summary);
    return respondError(c, { code: "internal_error", message: "Something went wrong on our side" });
  });

  return app;
}
