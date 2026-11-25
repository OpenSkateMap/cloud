# Contributing to OpenSkateMap

Thanks for wanting to help. This is the API and website behind the
[iOS app](https://github.com/OpenSkateMap/ios); a few minutes here saves both of us time.

Security issues don't go in issues or pull requests: see [SECURITY.md](SECURITY.md).

## Ask first

Some changes are welcome straight away, as a pull request:

- bug fixes,
- tests,
- docs,
- performance work that comes with a measurement.

**Open an issue first** for anything else:

- a new endpoint, or a change to an existing one's shape;
- a change to the rules about who can see or change what (review, collections, blocks, privacy);
- a new dependency or a new Cloudflare binding;
- a change to the website's pages or the legal texts.

## Spots aren't here

Spot data lives in the database, not in this repository. To add or correct a spot, use the app. Please don't post
spot locations in issues: some spots are kept quiet on purpose.

## Setting up

[RUNNING.md](RUNNING.md) runs everything locally with sample spots. [AGENTS.md](AGENTS.md)
has every command and the rules the code follows.

## How it works

### Deny by default

Every operation needs a signed-in account unless it's on a short public list, each entry with its reason next to
it ([`public-operations.ts`](apps/api/src/lib/public-operations.ts)). A test walks the OpenAPI document and calls
every other operation without a token, expecting a 401. Roles (rider, curator, admin) and blocks are checked on every
request.

### One contract

Zod schemas validate every request and response, and they *are* the OpenAPI document
([`/v1/openapi.json`](https://api.openskatemap.app/v1/openapi.json)). The iOS app generates its Swift client from
it, so a change to the API shows up as a compile error, not a crash.

### Sync by version

Every change to a spot takes the next number from one Postgres sequence, in commit order. The app asks for everything
after the last number it has, a page at a time, and gets removals as tombstones, so it never downloads the whole map
twice.

### People decide what's on the map

A new spot or an edit waits for review. The spot's adder sees suggestions to it first, then the city's curators,
then admins. Whoever decides can undo it for ten minutes. A spot saved into a private collection skips review, and
only that collection's people ever see it.

### Privacy

The API never shows anyone's email address to anyone else. The app re-encodes photos without their location before
uploading them, originals stay private, and only resized copies are served. Analytics are product analytics under an account id, off with one switch, and
deleting an account deletes them too.

## Making a change

- **One pull request does one thing.** Small ones get reviewed fastest.
- **Follow [AGENTS.md](AGENTS.md)** and update it when your change makes it wrong.
- **`bun run check`** (lint, typecheck, unit tests, the spec, the Worker bundle, the website build) and the end-to-end tests against the local database must pass,
  with no new warnings.
- **Every operation needs a signed-in account** unless it's added to `src/lib/public-operations.ts` with the reason
  next to it; the contract test checks.
- **Zod at the edges:** request and response schemas are the OpenAPI document. After changing one, run
  `bun run openapi` and commit `apps/api/openapi.json`; the iOS app regenerates its client from it.
- **Migrations** come from `bun run db:generate` (or `--custom` for hand-written SQL) and must work while the
  previous version of the Worker is still running: they're applied before it deploys.
- **Tests:** change behaviour, add a test for it; fix a bug, add the test that would have caught it.
- **Commits:** a short summary that starts with the area (`Review: …`, `Collections: …`), then a body that says why.

## Coding agents

The repository is set up for them: `AGENTS.md` at the root. Using one is fine, as long as you've read, run and
understood everything you send. Say in the pull request which parts an agent wrote. Large unreviewed changes get
closed.

## Licensing

Your contribution is licensed under this repository's licence, [AGPL-3.0-or-later](LICENSE).

## Conduct

Everyone here follows the [Code of Conduct](CODE_OF_CONDUCT.md).
