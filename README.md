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

Both development servers bind to `127.0.0.1` by default. In development, the
admin host accepts only explicit loopback values (`127.0.0.1`, `::1`, or
`localhost`); production self-hosting retains an explicit configurable bind.

### Persistent local services on macOS

The local maintenance workflow generates user-specific launchd jobs for the
primary checkout, stores logs under `~/Library/Logs/PackScout`, and restarts the
frontend, admin, and worker without copying secrets into plist files:

```bash
# Restart all three services in standard frontend mode.
npm run services:restart:local

# Restart one service and clear only the frontend's build caches.
npm run services:restart:local -- --clean frontend

# Use the local Convex mock release, with or without advancing Heat frames.
npm run services:restart:local -- --frontend-mode mock frontend
npm run services:restart:local -- --frontend-mode mock-heat frontend
```

The default `standard` frontend mode uses the normal `dev:frontend` command.
`mock` and `mock-heat` are explicit because they own a local Convex process;
neither mode deploys cloud functions. Admin and worker continue loading their
required database and key configuration from the ignored root `.env`. Mock
frontend modes require the ignored root `.env.local`.

The restart command is intentionally limited to the primary checkout because
launchd labels and ports are per-user singletons. It validates generated plists,
refuses to kill unrelated port owners, checks exact frontend/admin health
payloads, and reports worker process liveness without claiming worker health.

From a completely clean primary `main` checkout, update it safely with:

```bash
# Fast-forward origin/main, run npm ci, then restart all services.
npm run workspace:update:main:local

# Preview without fetching, changing refs/files, installing, or restarting.
npm run workspace:update:main:local -- --dry-run

# Forward explicit restart options after the update.
npm run workspace:update:main:local -- \
  --clean --frontend-mode mock-heat frontend worker
```

The updater refuses linked worktrees, detached or non-target branches, local
commits ahead of the remote, divergence, and every tracked or untracked change
(including `.tasks` and `output`). It performs only a fast-forward merge—never
checkout, reset, clean, or force—and preserves ignored environment files.

### Local Convex mock data release

The dashboard can use the deterministic six-repack data release in a local Convex
deployment. Start or configure Convex locally first so the ignored root
`.env.local` contains a loopback `CONVEX_URL` (or
`NEXT_PUBLIC_CONVEX_URL`). Then run:

```bash
# Push the current Convex functions and seed once. Replays refresh freshness.
npm run seed:mock-data-release:local

# Seed, supervise local Convex, then start the frontend after it is ready.
npm run dev:frontend:mock:local

# Publish one deterministic aggregate heat frame, then exit.
npm run simulate:mock-heat:local -- \
  --seed packscout-demo \
  --frame 0

# Run the complete frontend session with advancing mock heat.
npm run dev:frontend:mock-heat:local
```

The standalone seed command is one-shot and does not keep the local backend
running. The combined development command keeps the Convex backend alive for
the full frontend session, watches Convex functions, waits for backend
readiness before starting Next.js, and stops the supervised session on Ctrl+C
or a termination signal.

The heat simulator turns deterministic, ephemeral pull activity into bounded
repack heat aggregates in the local Node process. Convex receives only those
aggregate frames; it never receives or stores the synthetic pull activity.
One-shot mode is the default and resolves `startAt` to the current time. Add
`--loop` explicitly to publish every five wall-clock seconds while advancing
the deterministic scenario profile by one five-minute step. Public observation
and calculation timestamps advance by the publication cadence, so accelerated
scenario playback never future-dates evidence. The simulator prints the
canonical seed, `startAt`, run identifier, scenario step, and publication
cadence. Copy those printed controls into `--seed`, `--start-at`, `--frame`,
`--frame-step-ms`, and `--tick-ms` to replay a selected frame byte-for-byte.

The combined heat command publishes frame 0 before starting the frontend, then
advances the same run while Convex and Next.js are supervised. Ctrl+C, a
termination signal, or a simulator failure marks the last published frame
expired, stops the complete npm/npx process groups, and removes the temporary
simulation enable flag. A one-shot frame instead expires through its ID-bound scheduled
expiry. Simulated signals are visibly identified in the product and must not be
treated as live provider evidence or as EV.

All local mock commands refuse cloud/self-hosted URLs and deploy keys. The seed is an
internal Convex mutation, runs only when its temporary local enable flag is
present, refuses an active canonical release or partial/conflicting mock state,
and removes the enable flag before exiting. An unchanged replay advances only
the release observation timestamps; the release, repacks, shard, pointer, and
recorded seed operation stay immutable. No credential or public URL is
written to a tracked file or browser bundle beyond the required public Convex
origin.

### Cloud development data release

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
