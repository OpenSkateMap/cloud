# Running the OpenSkateMap backend

You need [mise](https://mise.jdx.dev), [bun](https://bun.sh) and Docker (or [OrbStack](https://orbstack.dev)).

```sh
mise install                      # hk, and the Git hooks: lint on commit, `bun run check` on push
bun install
bun run db:up                     # Postgres + PostGIS on port 54330
DATABASE_URL=postgres://openskatemap:openskatemap@localhost:54330/openskatemap bun run db:migrate
cp apps/api/.dev.vars.example apps/api/.dev.vars
#   set BETTER_AUTH_SECRET in apps/api/.dev.vars to any 32+ characters: openssl rand -base64 32
bun run --filter @openskatemap/api seed:local    # sample spots in London and Barcelona; prints a session token
bun run dev                       # the API, at the URL it prints (usually http://localhost:5173)
curl localhost:5173/v1/health
```

With the token, every route works from `curl` (`Authorization: Bearer <token>`), and the iOS app runs against
this server: see its [Running it locally](https://github.com/OpenSkateMap/ios#running-it-locally).

| Command | What it does |
|---|---|
| `bun run check` | Lint, typecheck and unit tests: what CI runs first |
| `E2E_DATABASE_URL=postgres://openskatemap_app:openskatemap_app@localhost:54330/openskatemap bun run --filter @openskatemap/api e2e` | The end-to-end tests, against the local database |
| `bun run openapi` | Regenerates `apps/api/openapi.json`; commit it with the change |
| `bun run db:generate` | A migration from changes to `packages/db/src/schema` |
| `bun run --filter @openskatemap/api create-city` | Adds a city (scripts in `apps/api/scripts` are admin tools) |

The full list, with the rules the code follows, is in [AGENTS.md](AGENTS.md).

## Running your own

The code is made to run on your own Cloudflare account. `apps/api/cloudflare.config.ts` declares every binding
(Hyperdrive, R2, Images, rate limits, scheduled jobs) with our resource ids; point them at yours. You'll need
Postgres with PostGIS (we run 18 with PostGIS 3.6), a Sign in with Apple key for your own app, and optionally
[BuzzKit](https://github.com/buzzkit-dev/buzzkit) for push and PostHog for analytics: without their keys, those parts
stay off. [AGENTS.md](AGENTS.md) describes each one.
