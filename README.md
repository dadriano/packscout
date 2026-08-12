# Packscout

Packscout is an npm workspace with two applications:

- `apps/frontend/` — the public Next.js 16 App Router application.
- `apps/admin/` — the React 19 and React Router 7 admin SPA, served by Express through Vite middleware in development.

The frontend currently renders a temporary foundation page while product routes are
being designed. The admin includes the reusable operator foundation: responsive
navigation, light/dark themes, shared dialog/confirmation/toast behavior, a typed
browser API client, and explicit unconfigured states for auth and persistence.

## Requirements

- Node.js 22 or newer
- npm 10.9.x

## Setup

```bash
npm install
```

## Development

```bash
# Frontend at http://localhost:5100
npm run dev

# Admin at http://localhost:5101 (HMR uses 5102)
npm run dev:admin

# Both applications
npm run dev:all
```

Packscout reserves the `5100–5199` range for local development so it can run
alongside other projects. Override the defaults from the shell when needed:

```bash
PACKSCOUT_FRONTEND_PORT=5150 npm run dev
PACKSCOUT_ADMIN_PORT=5151 PACKSCOUT_ADMIN_HMR_PORT=5152 npm run dev:admin
```

### Local Convex mock catalog

The dashboard can use the deterministic nine-pack catalog in a local Convex
deployment. Start or configure Convex locally first so the ignored root
`.env.local` contains a loopback `CONVEX_URL` (or
`NEXT_PUBLIC_CONVEX_URL`). Then run:

```bash
# Push the current Convex functions and seed once. Replays refresh freshness.
npm run seed:mock-catalog:local

# Seed, supervise local Convex, then start the frontend after it is ready.
npm run dev:frontend:mock:local
```

The standalone seed command is one-shot and does not keep the local backend
running. The combined development command keeps the Convex backend alive for
the full frontend session, watches Convex functions, waits for backend
readiness before starting Next.js, and stops the supervised session on Ctrl+C
or a termination signal.

Both commands refuse cloud/self-hosted URLs and deploy keys. The seed is an
internal Convex mutation, runs only when its temporary local enable flag is
present, refuses an active canonical catalog or partial/conflicting mock state,
and removes the enable flag before exiting. An unchanged replay advances only
the catalog observation timestamps; the snapshot, packs, shard, pointer, and
recorded seed operation stay immutable. No credential or public URL is
written to a tracked file or browser bundle beyond the required public Convex
origin.

### Cloud development catalog

The PackScout frontend can also read the project development deployment at
`https://abundant-puffin-373.convex.cloud`. Keep that public browser URL in the
ignored `apps/frontend/.env.development.local` file:

```dotenv
NEXT_PUBLIC_CONVEX_URL=https://abundant-puffin-373.convex.cloud
```

Then run `npm run dev:frontend`. Next.js loads the development-only file from
the frontend workspace, while production builds remain unconfigured until an
explicit production origin and matching security configuration are supplied.
The local seed commands above stay local-only and continue to refuse cloud
deployments and deploy keys.

## Verification

```bash
npm run verify:framework
```

This canonical gate checks architecture boundaries, dependency and script safety,
documentation integrity, the zero-debt standards ratchet, lint, type checks,
convention-discovered tests, and production builds for both applications.

The frontend exposes `GET /api/health` on port 5100. The admin Express server
exposes its own `GET /api/health` endpoint on port 5101. Unknown admin API routes
and malformed JSON return stable `{ "error": string, "code": string }` responses;
non-API browser routes continue to the Vite/SPA handler.
