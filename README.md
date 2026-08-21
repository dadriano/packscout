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

Database setup uses an empty PostgreSQL 16+ target and the checked-in Prisma
migrations. Follow the [database provisioning workflow](docs/database-provisioning.md)
before starting a database-backed runtime.

## Development

```bash
# Frontend at http://localhost:5100
npm run dev

# Admin at http://localhost:5101 (HMR uses 5102)
npm run dev:admin

# Local operations panel at http://127.0.0.1:5110 (HMR uses 5111)
npm run dev:ops-panel

# Both applications, each also teeing output to its per-service log file
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

### Local operations panel

`npm run dev:ops-panel` starts a loopback-only developer tool that discovers the
per-service log files local PackScout processes write, and shows the panel's own
audit trail of privileged attempts. It shares no authentication or runtime with
the product and admin apps, so it works when they do not, and it has no
production deployment target. See `ARCHITECTURE.md` for its access model and the
per-service log-file convention.

Every locally run service can produce a discoverable log file. The supervised
launchd workflow already does; the plain development workflow tees through a
wrapper:

```bash
npm run dev:frontend:logged:local
npm run dev:admin:logged:local
npm run dev:worker:logged:local
npm run dev:ops-panel:logged:local
```

`npm run dev:all` uses those wrapped commands, so output still reaches the
terminal and lands in `<log directory>/<service>.log` at the same time. Set
`PACKSCOUT_LOG_DIR` to point both the wrapper and the panel at another
directory.

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

### Optional Privy authentication

Dashboard, Repacks, Learn, and catalog search remain public. Authentication is
an optional enhancement for saving a repack or an exact desired collectible;
an unconfigured build keeps the anonymous application and its existing CSP.
Even when configured, the browser defers loading and initializing Privy until
the visitor chooses Sign in or a save action. A successful session stores only
a fixed, non-identifying returning-session hint so that a later visit can
restore authentication without persisting a Privy subject or email locally.

For local development, enable the Privy provider with the public app ID in the
ignored `apps/frontend/.env.development.local` file:

```dotenv
NEXT_PUBLIC_PRIVY_APP_ID=<public-privy-app-id>
```

Set the same public identifier as `PRIVY_APP_ID` in the environment of the
intended Convex deployment (for example,
`npx convex env set PRIVY_APP_ID <public-privy-app-id>` after confirming that
deployment). Setting the environment value does not rebuild Convex auth
configuration: explicitly push the functions and auth config to that same
confirmed target afterward. For the PackScout development deployment, use
`npx convex dev --once --deployment abundant-puffin-373`; production must use
the reviewed deployment workflow for its own target. The frontend and Convex
values must match exactly so Convex can validate the token audience. Missing
values disable their respective auth provider instead of making public reads
require authentication.

These matching values identify a public app; the frontend value is intentionally
browser-visible, and both are validated as bounded public identifiers. Do not
put a Privy app secret, token-verification key, access token,
email address, or any other secret or user data in a `NEXT_PUBLIC_` variable.
Any future server credential belongs in the deployment secret store under a
server-only name.

In the Privy Dashboard:

1. Enable only Email and Google under Authentication. This release does not
   enable wallet login or create embedded wallets.
2. Under Configuration > App settings > Domains, add every web origin exactly,
   including its protocol and development port, such as
   `http://localhost:5100`. Add the exact preproduction and production HTTPS
   origins separately; do not use a generic hosting-provider wildcard.
3. Under Configuration > App settings > Advanced, restrict OAuth redirect URLs
   to the exact PackScout destinations used by the deployment. Redirect entries
   do not support wildcards, query strings, or an incidental trailing slash.
4. Remove local and test origins from the production Privy app before launch.

See Privy's current guidance for
[allowed origins](https://docs.privy.io/recipes/dashboard/allowed-domains) and
[content security policy](https://docs.privy.io/security/implementation-guide/content-security-policy).
The app enables only the exact Privy authentication iframe/API and Cloudflare
Turnstile sources when the app ID is present. It does not allow WalletConnect,
wallet RPC, Coinbase Wallet, or generic wildcard sources.

Before enabling authentication in a live environment, use an actual Privy app
to verify email OTP, Google OAuth, logout, session expiry, mobile and keyboard
flows, exact-origin rejection, and a browser console with no CSP violations.
Do not infer live readiness from an environment-neutral build.

### Optional product-user directory in the admin

The admin's Users page lists people who signed up for the product. That data
lives in Convex, so the admin server reads it through a server-to-server
surface rather than querying Convex from the browser. Two server-only values
configure it:

```dotenv
PACKSCOUT_ADMIN_DIRECTORY_URL=<convex-site-url>
PACKSCOUT_ADMIN_DIRECTORY_TOKEN=<shared-secret-at-least-32-chars>
```

Set the same secret on the Convex deployment
(`npx convex env set PACKSCOUT_ADMIN_DIRECTORY_TOKEN <value>` against the
confirmed deployment). The Convex side fails closed: an absent or too-short
secret refuses every request, so the directory is unreachable until both sides
are configured.

Neither value belongs in a `NEXT_PUBLIC_` or otherwise browser-visible
variable — the token authorizes reading personal data (email addresses and
wallet-linked identities). The admin never sends it to the browser.

Leaving these unset is safe and supported: the admin still boots and the Users
page shows a bounded "not connected" state instead of failing. Only operators
holding the `product_users:view` permission (administrators) see the page at
all.

### Machinery alerting in the admin

The admin server evaluates the pipeline's machinery conditions — a silent
worker fleet, a stalled import run, an overdue provider schedule, a backed-up
recomputation queue, and retention that stopped running — and raises them
through the same operational alerts as every other condition. The cycle runs
here rather than in the worker because the loudest condition is that no worker
is alive; a detector inside the fleet would die with it.

Its thresholds come from the settings the worker fleet publishes, so a page and
an alert cannot disagree. Two server-only values tune the rest, and both have
safe defaults:

```dotenv
PACKSCOUT_ADMIN_MACHINERY_ALERT_INTERVAL_MS=60000
PACKSCOUT_ADMIN_RECOMPUTATION_BACKLOG_LIMIT=100
```

The interval decides only how quickly a condition is noticed. The backlog limit
is the queue depth a workspace may owe before depth alone counts as a backlog,
and the background-work page reads the same value, so the badge and the alert
flip together. Alerts stay inside the existing notification boundary: nothing
is emailed or posted to an external endpoint.

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
