# Packscout Architecture

Status: current architecture

## Workspace

```text
packscout/
├── apps/
│   ├── frontend/   Next.js user-facing application
│   ├── admin/      Vite/React admin SPA and Express adapter
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
  ├── frontend:5100 -> Next.js routes and frontend API adapters
  └── admin:5101    -> Express -> admin API routes
                               -> Vite middleware in development
                               -> built SPA files in production

Worker -> provider adapters -> services -> Prisma repositories -> PostgreSQL 16+
```

Packscout reserves local ports `5100–5199`. The default admin Vite HMR socket
uses `5102`; future local services should remain in this range unless an
external protocol requires a conventional port.

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

## Dependency direction

```text
frontend UI -> frontend server components/API adapters -> shared services -> persistence/external APIs
admin UI    -> admin client API helpers -> Express adapters -> shared services -> Prisma repositories -> PostgreSQL
worker      -> provider adapters -> shared services -> Prisma repositories -> PostgreSQL
```

Rules:

- `apps/frontend` and `apps/admin` do not import one another.
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
