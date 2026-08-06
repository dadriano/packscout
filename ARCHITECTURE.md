# Packscout Architecture

Status: current architecture

## Workspace

```text
packscout/
├── apps/
│   ├── frontend/   Next.js user-facing application
│   └── admin/      Vite/React admin SPA and Express adapter
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
```

Packscout reserves local ports `5100–5199`. The default admin Vite HMR socket
uses `5102`; future local services should remain in this range unless an
external protocol requires a conventional port.

The current apps expose independent `/api/health` endpoints. The admin also owns a
typed browser API client and a structured API fallback: malformed JSON and unknown
`/api/*` routes return stable JSON errors before browser routes reach the SPA.
Authentication, persistence, and shared domain services have not been selected yet;
the standards and admin UI describe those boundaries without pretending the systems
already exist.

## Admin foundation

The admin starts with an operational shell rather than feature-specific routes:

- responsive navigation with an accessible drawer on narrow viewports,
- light and dark themes using shared CSS tokens,
- shared dialog, confirmation, toast, button, status, and empty-state patterns,
- client requests isolated under `apps/admin/src/api`, and
- visible unconfigured states for authentication and persistence.

These are presentation and transport foundations only. They do not authorize users,
establish tenant scope, or persist data. The first protected or mutating admin feature
must introduce its real boundary design and direct route coverage with the feature.

## Dependency direction

```text
frontend UI -> frontend server components/API adapters -> future shared services -> persistence/external APIs
admin UI    -> admin client API helpers -> Express adapters -> future shared services -> persistence/external APIs
```

Rules:

- `apps/frontend` and `apps/admin` do not import one another.
- `apps/admin/src` never imports `apps/admin/server`, Express, dotenv, or Node-only modules.
- frontend client components never import `next/server`, Node-only modules, or future server-only packages.
- Express and Next route handlers adapt transport concerns; shared workflows should move behind a transport-neutral service API when a second caller needs them.
- Future cross-app packages expose public entry points. Consumers never deep-import another package's `src` directory.

## Ownership

- Pages and components own rendering, interaction state, and accessible feedback.
- API adapters own authentication, authorization, request validation, response shaping, and error mapping.
- Services own reusable use cases, transactions, persistence policy, audit behavior, and external-provider orchestration.
- Pure shared contracts own runtime-neutral types and validation only after real cross-surface reuse exists.

## Configuration and secrets

Local secrets belong in ignored `.env` files. Browser bundles may receive only explicitly public variables. Secrets must be read and used server-side, never logged, returned by health routes, or embedded in client code.

## Quality gates

Every pull request and push to `main` runs `npm run verify:framework`. The gate checks boundaries, living documentation, package-script safety, dependency exceptions, the standards ratchet, lint, type checks, convention-discovered tests, and production builds.
