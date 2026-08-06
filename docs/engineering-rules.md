# Engineering Rules

Status: canonical project-wide rules

These rules apply to human and automated contributors.

## Generic-first infrastructure

- Generic infrastructure must remain workflow- and entity-agnostic.
- Do not hardcode dynamic product concepts in shared routing, service, persistence, or integration infrastructure when typed configuration can represent them.
- A truly product-specific implementation should live in an explicit feature boundary rather than being mixed into generic helpers.

## Provider isolation

- Third-party provider details—API clients, OAuth, webhooks, tool names, prompts, and provider-specific copy—belong in provider modules reached through a common interface or registry.
- Generic flows must not branch on provider identifiers.
- Adding a provider should require registration and provider-local code, not edits throughout common orchestration.
- If the shared interface is insufficient, extend it with a capability other providers can adopt instead of adding a one-off branch.

## Data-driven behavior

- Prefer typed configuration and constrained action vocabularies to hardcoded workflow-name branching.
- Keep sequencing, rules, feature availability, and transitions data-driven where practical.
- Validate configuration at its owning boundary and fail closed on unknown values.

## Deliberate compatibility

Do not add aliases, legacy fallbacks, dual reads, dual writes, or compatibility adapters as implementation conveniences. An approved compatibility design must document:

- the exact legacy shape being supported,
- why support is necessary,
- the migration or reset strategy,
- the owner, and
- the removal trigger.

Early in product development, prefer replacing obsolete data or APIs over creating parallel sources of truth.

## Browser/server boundaries

- Browser code cannot import server routes, Node-only modules, secret-bearing helpers, database clients, or server-only service implementations.
- `frontend` and `admin` do not import one another.
- Public HTTP inputs are untrusted. Authenticate, authorize, validate, delegate, and map errors in that order.
- Stable error responses use `{ "error": string, "code"?: string }` unless a feature contract explicitly defines another shape.

## Shared behavior

- Do not duplicate the same persistence query, authorization decision, transaction, or provider workflow across frontend and admin.
- Introduce a shared service only when behavior is genuinely reused or establishes a security-critical canonical decision.
- Shared packages expose intentional public entry points. Deep imports into another package's source tree are forbidden.

## Security-sensitive work

- Auth/session behavior, permission changes, tenant boundaries, secrets, destructive actions, external writes, and rate limits require direct boundary tests.
- Do not rely on hidden controls for authorization; enforce it server-side.
- Secrets must never enter browser bundles, logs, audit payloads, health responses, or committed fixtures.
- Destructive operations require explicit confirmation and a recovery story.

## Environment-specific scripts

- Root and package `scripts` entries must be safe in every environment unless their names state the scope.
- Place environment-specific utilities under `scripts/local`, `scripts/preproduction`, or `scripts/live`.
- Destructive script names require qualifiers such as `:local`, `:preproduction`, or `:live`.
- Environment checks must be enforced inside the script, not trusted to the caller.

## Dependency exceptions

- New high or critical dependency advisories fail the framework gate.
- A temporary exception requires a specific advisory ID, affected package, reason, owner context, and expiration date in `dependency-audit.json`.
- Expired, stale, or broad exceptions fail the gate. Exceptions are not permanent risk acceptance.

## Temporary exceptions

Any standards exception must identify the affected file or contract, reason, owner, and removal condition. Do not weaken a repository-wide checker to accommodate a local exception.
