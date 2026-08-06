# Framework Technical Layout

Status: current target layout

## Dependency direction

```text
frontend UI -> frontend server/API adapters -> future services -> persistence or external APIs
admin UI -> apps/admin/src/api -> Express adapters -> future services -> persistence or external APIs
```

| Source | May depend on | Must not depend on |
|---|---|---|
| `frontend` server files | Next server APIs, browser-safe contracts, future server services | Admin code |
| Frontend client components | React, browser-safe helpers and contracts | Node modules, Express, `next/server`, admin code |
| `apps/admin/src` | React, React Router, browser-safe helpers, `apps/admin/src/api` | Express, dotenv, Node modules, `apps/admin/server`, frontend code |
| `apps/admin/server` | Express, Node modules, future server services | Admin React modules, frontend code |

## Frontend feature slice

```text
apps/frontend/app/<route>/page.tsx                 # Route entry and server loading
apps/frontend/app/<route>/<Feature>Client.tsx      # Browser interaction when needed
apps/frontend/app/api/<resource>/route.ts          # Frontend HTTP adapter
apps/frontend/components/<feature>/                # Reusable frontend presentation
apps/frontend/hooks/<feature>/                     # Browser state and orchestration
apps/frontend/lib/<feature>.server.ts              # Server-only frontend helper
apps/frontend/lib/<feature>.client.ts              # Browser-safe helper
```

Tests live beside their owner as `*.test.ts`, `*.test.tsx`, or `*.behavior.test.tsx`. API route tests live beside the route.

## Admin feature slice

```text
apps/admin/server/routes/<feature>.ts              # Express adapter
apps/admin/server/routes/<feature>.behavior.test.ts
apps/admin/src/api/<feature>.ts                    # Typed browser API client
apps/admin/src/pages/<Feature>Page.tsx             # Route-level screen
apps/admin/src/components/<feature>/               # Reusable admin presentation
apps/admin/src/hooks/<feature>/                     # Admin browser state
```

The Express adapter parses and validates transport inputs. Reusable workflows should not be duplicated in the route when another surface needs them.

## Future shared packages

Do not create empty symmetry. Add packages only when real behavior needs a canonical home:

```text
packages/services/src/<domain>-service.ts      # Server use cases and persistence orchestration
packages/contracts/src/<domain>.ts             # Pure cross-surface contracts
```

Each package must expose public exports and participate in the root workspace. Browser-safe and server-only entry points must remain distinct.

## Cross-surface contracts

| Integration | Contract owner | Implementation owner | Test owner |
|---|---|---|---|
| Browser to frontend API | Frontend response types | Frontend route and client helper | Route and client behavior tests |
| Admin UI to Express | `apps/admin/src/api` contract | Admin route and client helper | Route and page/component tests |
| Multiple transports to one workflow | Future service public API | Service plus thin adapters | Service tests first, adapter tests second |

## Shift-left order

1. Record or update the behavior scenario.
2. Test pure validation and transformation rules.
3. Test reusable service behavior before transport adapters.
4. Test HTTP auth, validation, and response mapping.
5. Test UI states and accessibility-sensitive behavior.
6. Use browser/E2E coverage only for cross-layer or visual risk.
7. Run the package checks, then the full verifier.

## Documentation ownership

- Durable standards live under `docs/`.
- Buildable task state and scenarios live under `.tasks/`.
- Root contributor files point to canonical documents rather than duplicating them.
- Documentation must distinguish current state from a future target.
