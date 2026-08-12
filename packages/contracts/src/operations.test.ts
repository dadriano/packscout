import assert from "node:assert/strict";
import { test } from "node:test";
import { operationalNotificationSchema } from "./operations.ts";

const event = {
  id: "40000000-0000-4000-8000-000000000001",
  organizationId: "40000000-0000-4000-8000-000000000002",
  kind: "run_failed",
  severity: "critical",
  providerId: "40000000-0000-4000-8000-000000000003",
  runId: "40000000-0000-4000-8000-000000000004",
  quarantineId: null,
  dedupeKey: "provider:failure:40000000-0000-4000-8000-000000000003",
  recoveryKey: "provider:health:40000000-0000-4000-8000-000000000003",
  title: "Provider import failed",
  summary: "The import stopped with a sanitized failure code.",
  evidence: { failureCode: "PROVIDER_IMPORT_FAILED", count: 1 },
  occurredAt: "2026-08-06T12:00:00.000Z",
} as const;

test("operational notifications accept only bounded allowlisted evidence", () => {
  assert.equal(operationalNotificationSchema.safeParse(event).success, true);
  assert.equal(
    operationalNotificationSchema.safeParse({
      ...event,
      evidence: { ...event.evidence, rawPayload: { token: "secret" } },
    }).success,
    false,
  );
  assert.equal(
    operationalNotificationSchema.safeParse({
      ...event,
      summary: "Authorization: Bearer should-never-be-stored",
    }).success,
    false,
  );
  assert.equal(
    operationalNotificationSchema.safeParse({
      ...event,
      evidence: { failureCode: "Bearer secret" },
    }).success,
    false,
  );
});
