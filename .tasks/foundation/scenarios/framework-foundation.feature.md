# Feature: Packscout framework foundation

Status: implemented
Owner: foundation

## Scenario: A developer verifies the whole workspace

Given the frontend and admin workspaces are installed from the root lockfile
When the developer runs `npm run verify:framework`
Then repository checks, standards scanning, lint, type checks, tests, and production builds all pass
And both applications are covered by the gate

Coverage: Automated — `npm run verify:framework`

## Scenario: Health checks expose safe liveness responses

Given either application server is running
When a client requests `/api/health`
Then it receives a successful stable JSON response naming the service
And the response contains no secrets or internal dependency details

Coverage: Automated — `apps/frontend/app/api/health/route.behavior.test.ts` and `apps/admin/server/routes/health.behavior.test.ts`

## Scenario: Frontend responses keep the security header baseline

Given a route is served by the frontend application
When Next.js applies the global response headers
Then framing, MIME sniffing, and unsafe browser capabilities are restricted
And CSP and HSTS remain configured

Coverage: Automated — `apps/frontend/next-config.behavior.test.ts`

## Scenario: Packscout coexists with other local applications

Given another project is already listening on ports 3000 and 3001
When a developer starts both Packscout applications with their defaults
Then the frontend listens on 5100 and the admin listens on 5101
And admin hot reload uses 5102 within Packscout's reserved range

Coverage: Automated — `scripts/port-range.test.mjs`; runtime smoke checked with both applications active

## Scenario: Temporary pages remain usable across viewport sizes

Given the foundation pages are rendered in a browser
When they are viewed at desktop and mobile widths
Then the primary content remains readable and navigable
And there is no horizontal overflow or browser console error

Coverage: Manual gap — verified in the in-app browser at 1440×1000 and 390×844; add component or visual regression infrastructure when product interactions begin.
