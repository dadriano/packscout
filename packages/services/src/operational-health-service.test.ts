import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OperationalHealthService,
  type OperationalHealthSnapshot,
} from "./operational-health-service.ts";

const organizationId = "52000000-0000-4000-8000-000000000001";
const checkedAt = new Date("2026-08-06T12:00:00.000Z");

function snapshot(
  overrides: Partial<OperationalHealthSnapshot> = {},
): OperationalHealthSnapshot {
  return {
    configuredProviderCount: 1,
    staleProviderCount: 0,
    degradedProviderCount: 0,
    failedProviderCount: 0,
    activeAlertCount: 0,
    latestRetentionState: "succeeded",
    latestRetentionAt: checkedAt,
    latestRetentionFailureCode: null,
    ...overrides,
  };
}

test("liveness is shallow while protected detail distinguishes dependency states", async () => {
  let current = snapshot();
  const service = new OperationalHealthService(
    { loadSnapshot: () => Promise.resolve(current) },
    { now: () => new Date(checkedAt) },
  );
  assert.deepEqual(service.liveness(), { status: "live" });
  assert.equal((await service.protectedDetail(organizationId)).state, "healthy");
  current = snapshot({ configuredProviderCount: 0 });
  assert.equal((await service.protectedDetail(organizationId)).state, "unconfigured");
  current = snapshot({ staleProviderCount: 1 });
  assert.equal((await service.protectedDetail(organizationId)).state, "stale");
  current = snapshot({ degradedProviderCount: 1 });
  assert.equal((await service.protectedDetail(organizationId)).state, "degraded");
  current = snapshot({ latestRetentionState: "failed", latestRetentionFailureCode: "RETENTION_FAILED" });
  assert.equal((await service.protectedDetail(organizationId)).state, "failed");
});
