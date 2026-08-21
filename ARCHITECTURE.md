# Packscout Architecture

Status: current architecture

## Workspace

```text
packscout/
├── apps/
│   ├── frontend/   Next.js user-facing application
│   ├── admin/      Vite/React admin SPA and Express adapter
│   ├── ops-panel/  Loopback-only local operations panel (developer tool)
│   └── worker/     Provider import and operational worker runtime
├── packages/
│   ├── contracts/  Browser-safe schemas and shared contracts
│   ├── database/   Prisma persistence and PostgreSQL repositories
│   └── services/   Server-side domain workflows
├── scripts/    Repository checks and environment-scoped utilities
├── docs/       Canonical engineering standards
└── .tasks/     Feature plans and BDD scenarios
```

The repository uses npm workspaces with one root lockfile. Each app owns its framework configuration and can be built independently.

## Runtime topology

```text
Browser
  ├── frontend:5100  -> Next.js routes and frontend API adapters
  ├── admin:5101     -> Express -> admin API routes
                                -> Vite middleware in development
                                -> built SPA files in production
  └── ops-panel:5110 -> Express -> panel API routes (loopback bind only)
                                -> Vite middleware; development only

Worker -> provider adapters -> services -> Prisma repositories -> PostgreSQL 16+
```

Packscout reserves local ports `5100–5199`. The default admin Vite HMR socket
uses `5102`, and the operations panel uses `5110` with `5111` for its HMR
socket; future local services should remain in this range unless an external
protocol requires a conventional port.

The apps expose independent `/api/health` endpoints. The admin also owns a typed
browser API client and a structured API fallback: malformed JSON and unknown
`/api/*` routes return stable JSON errors before browser routes reach the SPA.
Admin authentication and organization-scoped operations run through shared server
services. PostgreSQL 16+ is the canonical database; Prisma ORM, Prisma Client, and
Prisma Migrate are the only application persistence and migration path.

## Admin foundation

The admin starts with an operational shell rather than feature-specific routes:

- responsive navigation with an accessible drawer on narrow viewports,
- light and dark themes using shared CSS tokens,
- shared dialog, confirmation, toast, button, status, and empty-state patterns,
- client requests isolated under `apps/admin/src/api`, and
- protected provider, import, quarantine, alert, health, and operator workflows.

The Express boundary authenticates, authorizes, validates, delegates to shared
services, and maps stable errors. Organization scope and mutation permissions are
enforced again at the persistence boundary and covered directly by integration tests.

The admin server also hosts one bounded background cycle: the machinery alert
evaluation. It is the only periodic work outside the worker, and deliberately so
— it detects a dead worker fleet, which a detector inside that fleet could not.
It reads the same shared condition evaluations the monitoring pages render and
publishes through the existing operational alert path.

## Local operations panel

`apps/ops-panel` is a developer tool, not a product surface. It is deliberately
independent of product and admin authentication so it still works when they are
broken, and it is never deployed to shared or production infrastructure.

- It binds loopback only (`127.0.0.1` by default; a non-loopback bind is a
  configuration error). Remote use is an SSH tunnel landing on that same bind.
- Its security model is structural rather than account-based. Mutations and raw
  log downloads require the `x-packscout-ops-panel` request header, which a
  cross-origin page cannot set without a preflight the panel never approves.
  An `Origin` header, when present, must be a loopback origin.
- Sensitive reads — every path under `/api/logs`, `/api/database`, and
  `/api/activity` — additionally require a loopback `Host` header, which
  defeats DNS rebinding.
- Event-stream endpoints relax the custom header only as far as the browser's
  `EventSource` client requires; the loopback checks always apply.
- Every privileged attempt — succeeded, failed, or rejected — lands in a
  bounded, persisted, reverse-chronological audit trail the panel displays.
- No endpoint, parameter, or debug path runs a caller-supplied command, path, or
  SQL statement. This is a permanent design invariant.

Non-trivial panel logic (source discovery, guards, audit, stream framing) lives
in framework-free modules under `apps/ops-panel/server/core` with colocated
tests, so behavior is provable without a browser.

## Per-service local log files

Locally run PackScout processes write one append-only file per service into a
single discoverable directory, which is what the operations panel reads:

- directory: `PACKSCOUT_LOG_DIR` when set, otherwise
  `~/Library/Logs/PackScout` on macOS and
  `${XDG_STATE_HOME:-~/.local/state}/packscout/logs` elsewhere;
- file name: `<service>.log`, where `<service>` is lowercase letters, digits,
  and inner hyphens (1–64 characters). Names outside that set are ignored
  rather than guessed at.

The supervised launchd workflow redirects each service's output to these files.
The plain development workflow reaches the same convention through
`scripts/local/run-service-with-log.mjs`, which tees a known service's output to
its file while leaving it on stdout. A new service joins by following the naming
pattern; nothing needs to register with the panel.

## Dependency direction

```text
frontend UI -> frontend server components/API adapters -> shared services -> persistence/external APIs
admin UI    -> admin client API helpers -> Express adapters -> shared services -> Prisma repositories -> PostgreSQL
worker      -> provider adapters -> shared services -> Prisma repositories -> PostgreSQL
ops-panel UI -> ops-panel client API helpers -> Express adapters -> panel core modules -> local filesystem
```

Rules:

- `apps/frontend` and `apps/admin` do not import one another.
- `apps/ops-panel` imports no other application and no shared workspace package;
  its independence from the product runtime is the point of the tool.
- `apps/ops-panel/src` is browser code; `apps/ops-panel/server` is server code,
  and browser code never imports it.
- `apps/admin/src` never imports `apps/admin/server`, Express, dotenv, or Node-only modules.
- frontend client components never import `next/server`, Node-only modules, or server-only packages.
- Express and Next route handlers adapt transport concerns; shared workflows should move behind a transport-neutral service API when a second caller needs them.
- Cross-app packages expose public entry points. Consumers never deep-import another package's `src` directory.

## Ownership

- Pages and components own rendering, interaction state, and accessible feedback.
- API adapters own authentication, authorization, request validation, response shaping, and error mapping.
- Services own reusable use cases, transactions, persistence policy, audit behavior, and external-provider orchestration.
- Pure shared contracts own runtime-neutral types and validation only after real cross-surface reuse exists.

## Configuration and secrets

Local secrets belong in ignored `.env` files. Browser bundles may receive only explicitly public variables. Secrets must be read and used server-side, never logged, returned by health routes, or embedded in client code.

## Quality gates

Every pull request and push to `main` runs `npm run verify:framework`. The gate checks boundaries, living documentation, package-script safety, dependency exceptions, the standards ratchet, lint, type checks, convention-discovered tests, and production builds.
