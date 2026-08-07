import assert from "node:assert/strict";
import { test } from "node:test";
import type { AdminAlertDetail, AdminAlertSummary } from "@packscout/contracts";
import type { ProviderActor } from "./provider-configuration-service.ts";
import {
  OperationalAlertService,
  OperationalAlertServiceError,
  type OperationalAlertRepository,
} from "./operational-alert-service.ts";

const organizationId = "53000000-0000-4000-8000-000000000001";
const otherOrganizationId = "53000000-0000-4000-8000-000000000002";
const alertId = "53000000-0000-4000-8000-000000000003";
const now = new Date("2026-08-06T12:00:00.000Z");

const summary: AdminAlertSummary = {
  id: alertId,
  kind: "provider_stale",
  severity: "warning",
  state: "active",
  title: "Provider data is stale",
  summary: "The provider has not reached its freshness target.",
  providerId: "53000000-0000-4000-8000-000000000004",
  runId: null,
  quarantineId: null,
  firstSeenAt: now.toISOString(),
  lastSeenAt: now.toISOString(),
  occurrenceCount: 1,
  reopenedCount: 0,
  acknowledgedAt: null,
  resolvedAt: null,
};
const detail: AdminAlertDetail = { ...summary, occurrences: [] };

function actor(
  role: ProviderActor["role"] = "data_operator",
  tenant = organizationId,
): ProviderActor {
  return { organizationId: tenant, operatorId: "operator-1", role };
}

test("alert operations authorize roles and always scope repository access to the actor tenant", async () => {
  const tenants: string[] = [];
  const repository: OperationalAlertRepository = {
    listAlerts(input) {
      tenants.push(input.organizationId);
      return Promise.resolve(input.organizationId === organizationId ? [summary] : []);
    },
    getAlert(tenant) {
      tenants.push(tenant);
      return Promise.resolve(tenant === organizationId ? detail : null);
    },
    acknowledge(input) {
      tenants.push(input.organizationId);
      return Promise.resolve({ ...summary, state: "acknowledged", acknowledgedAt: now.toISOString() });
    },
    resolve(input) {
      tenants.push(input.organizationId);
      return Promise.resolve({ ...summary, state: "resolved", resolvedAt: now.toISOString() });
    },
  };
  const service = new OperationalAlertService(
    repository,
    { keyFor: ({ operatorId }) => `actor:${operatorId}` },
    { now: () => new Date(now) },
  );
  assert.equal((await service.list(actor(), {})).length, 1);
  assert.equal((await service.detail(actor("admin"), alertId)).id, alertId);
  assert.equal((await service.acknowledge(actor(), alertId)).state, "acknowledged");
  assert.equal((await service.resolve(actor("admin"), alertId)).state, "resolved");
  assert.deepEqual(tenants, Array(5).fill(organizationId));
  await assert.rejects(
    service.detail(actor("admin", otherOrganizationId), alertId),
    (error: unknown) =>
      error instanceof OperationalAlertServiceError && error.code === "ALERT_NOT_FOUND",
  );
  assert.equal(tenants.at(-1), otherOrganizationId);
});

test("alert operations reject unauthorized roles and malformed identifiers before persistence", async () => {
  let calls = 0;
  const repository: OperationalAlertRepository = {
    listAlerts: () => { calls += 1; return Promise.resolve([]); },
    getAlert: () => { calls += 1; return Promise.resolve(null); },
    acknowledge: () => { calls += 1; return Promise.resolve(null); },
    resolve: () => { calls += 1; return Promise.resolve(null); },
  };
  const service = new OperationalAlertService(
    repository,
    { keyFor: () => "actor:test" },
    { now: () => new Date(now) },
  );
  assert.throws(
    () => service.list({ ...actor(), role: "viewer" } as unknown as ProviderActor, {}),
    (error: unknown) =>
      error instanceof OperationalAlertServiceError && error.code === "FORBIDDEN",
  );
  await assert.rejects(
    service.detail(actor(), "not-an-alert-id"),
    (error: unknown) =>
      error instanceof OperationalAlertServiceError &&
      error.code === "INVALID_ALERT_REQUEST",
  );
  assert.equal(calls, 0);
});
