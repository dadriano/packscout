# Task: Preserve the Data Feed Lab

**ID:** distributed-canonical-warehouse/011
**Depends on:** distributed-canonical-warehouse/002, distributed-canonical-warehouse/003
**Blocks:** distributed-canonical-warehouse/020
**Estimated scope:** small
**Estimated effort:** 1–2 days for one builder, including safe proxy parity and failure-state verification
**Status:** not started

## Start Here

Record the current Data Feed Lab request bounds, safe response projection, credential source, and every existing failure classification before routing its provider selection through the new registry.

## Objective

Preserve the current read-only Data Feed Lab so authorized operators can inspect bounded upstream responses without creating new persistence or exposing provider credentials.

## Context

The Data Feed Lab is a transient diagnostic proxy at `/data-api-tester`. It is not a canonical importer, source adapter, mapper, raw archive, or provider runtime command. Its environment-backed server credential and fixed upstream destination remain outside browser control. The provider registry supplies safe filter identities, while upstream wire vocabulary may retain an external `platform` field only inside this diagnostic boundary.

No database table is added for the lab. Its requests and responses remain transient and bounded.

## Requirements

### Safe request behavior

- Require authenticated provider viewing permission, trusted Origin, and CSRF before sending a diagnostic request.
- Accept `All providers` or one validated provider selection, a bounded record limit up to 5,000, and a bounded cursor up to 4,096 characters.
- Resolve the environment-backed credential, destination, and provider-ID-to-external-filter mapping server-side; `All providers` omits the upstream filter, and the browser cannot supply a URL, host, authorization value, or database target.
- Keep the request read-only, use a fixed destination policy, handle redirects manually, and enforce bounded timeout and response size.
- Disable execution with explicit guidance when the required credential or safe configuration is absent.

### Safe response behavior

- Preserve All providers, single-provider, limit, cursor, all returned record kinds, record `data`, Raw JSON view, and staging of the returned cursor.
- Return the exact bounded validated diagnostic records and raw JSON to the authorized Lab only; render raw content as inert text and never pass through an upstream error body, authorization header, or credential.
- Preserve stable failures for invalid input, authentication rejection, redirect, timeout, oversized body, invalid JSON, invalid shape, and network failure.
- Keep diagnostic requests and raw results transient; do not persist them in canonical, raw-page, run, cursor, quarantine, audit, alert, or log storage.
- Use canonical provider terminology in PackScout UI and contracts while isolating external wire vocabulary inside the proxy boundary.

### Accessible diagnostic states

- Preserve loading, disabled, empty, success, validation, timeout, redirect, oversized, malformed, authentication, and network-failure states.
- Keep provider, limit, and cursor inputs labelled and keyboard operable.
- Announce execution and failure outcomes without relying on color.
- Preserve entered safe values after a recoverable failure.
- Move focus to actionable validation or service errors.

## User-Facing Behavior

Authorized operators keep the existing Data Feed Lab workflow: select All providers or one provider, set a bounded limit or cursor, send a read-only request, inspect record data or Raw JSON, and stage the next cursor. Missing credentials disable execution. Upstream failures remain concise and never reveal the upstream error body.

## Interface Contract

The browser supplies an optional validated provider ID, bounded limit, and bounded opaque cursor. The server resolves the fixed diagnostic destination, environment-backed credential, and external provider filter. The response contains sanitized transport status, bounded validated raw records, counts, and a bounded next cursor when present.

The lab does not emit provider runs, page commits, canonical writes, promotion changes, central activity, or durable cursor changes.

## Acceptance Criteria

### Diagnostic acceptance

- [ ] Current All providers, single-provider, limit, cursor, send, record data, Raw JSON, and stage-next-cursor behavior remains available.
- [ ] Missing credentials disable sending with explicit guidance and no upstream request.
- [ ] The browser cannot select a URL, database host, credential, or authorization header.
- [ ] Redirect, timeout, oversized, malformed, authentication, validation, and network failures return stable sanitized outcomes.
- [ ] Provider ID maps server-side to the external diagnostic filter, while All providers omits that filter under the same environment-backed credential.
- [ ] No new table, canonical write, run, quarantine, promotion change, or durable cursor is created.

### Safety acceptance

- [ ] Provider ownership, permission, Origin, CSRF, destination, timeout, body, limit, and cursor bounds have direct tests.
- [ ] Credentials, authorization values, and upstream error bodies never appear; authorized bounded raw results appear only in the transient Lab response and never in logs, audits, alerts, or persistence.
- [ ] External `platform` vocabulary remains contained inside the diagnostic wire boundary.
- [ ] Loading, disabled, success, and every failure state remain keyboard accessible and announced.
- [ ] Data Feed Lab behavior remains independent of provider importer or mapper implementation.

## Spec Compliance

- Implementation authority: `tech-001-database-schema-contract.md`.
- The Lab remains transient and adds no persistence table, canonical write, run, cursor, or quarantine record.
- No deviations are planned; acceptance evidence is recorded before this task is marked complete.
