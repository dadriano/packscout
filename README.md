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
