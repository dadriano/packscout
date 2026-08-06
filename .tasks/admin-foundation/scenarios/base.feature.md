# Feature: Admin foundation

Status: implemented
Owner: admin-foundation

## Scenario: An operator can orient in the admin workspace

Given the admin application is running
When an operator opens the overview
Then the responsive operations shell identifies the active workspace
And the service, guardrail, and deliberate-deferral states are visible

Coverage: Automated — `apps/admin/src/pages/OverviewPage.test.tsx`; browser smoke at desktop and mobile viewports

## Scenario: An operator receives accessible global interaction feedback

Given a future admin workflow uses the shared dialog, confirmation, or toast foundation
When that workflow opens a dialog or publishes feedback
Then the dialog is labelled, focus-managed, and keyboard-dismissible when safe
And notifications are announced without blocking the workflow

Coverage: Automated — `apps/admin/src/components/AdminDialog.test.tsx`; browser smoke for theme and responsive navigation

## Scenario: Invalid API requests fail with a stable contract

Given a client sends malformed JSON or requests an unknown admin API route
When the Express adapter handles the request
Then it returns a structured `{ error, code }` response
And implementation details are not leaked

Coverage: Automated — `apps/admin/server/app.test.ts`

## Scenario: Security boundaries are not implied before design

Given authentication, roles, tenants, and persistence have not been selected
When the admin foundation is rendered
Then the interface labels those boundaries as unconfigured
And no placeholder route is represented as protected

Coverage: Automated — `apps/admin/src/pages/OverviewPage.test.tsx`; architecture contract in `ARCHITECTURE.md`
