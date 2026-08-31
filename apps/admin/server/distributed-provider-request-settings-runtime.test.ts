import assert from "node:assert/strict";
import { test } from "node:test";
import { createLaunchSourceIntegrationCapabilities } from "@packscout/services";
import type { CentralPrismaClient, ProviderPrismaClient, ProviderRequestSettingsRevision, ReviseProviderRequestSettingsResult } from "@packscout/database";
import { createDistributedProviderRequestSettingsRuntime } from "./distributed-provider-request-settings-runtime.ts";

const id = (value: number) => `82000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const now = new Date("2026-08-31T02:00:00Z");
const revision: ProviderRequestSettingsRevision = {
  id: id(6), revisionNumber: 2n, recordsPerRequest: 100, origin: "operator",
  configVersionId: id(9), configVersionNumber: 1n, adapterKey: "dataforrest-phygitals-distributed-adapter-v2",
  createdByOperatorId: id(2), createdAt: now,
};
const command = { organizationId: id(1), operatorId: id(2), providerId: id(3), request: {
  expectedConfigVersionId: id(4), expectedRequestSettingsRevisionId: id(6), recordsPerRequest: 1_000,
} };

function fixture() {
  const queries: unknown[] = [];
  const routes: unknown[] = [];
  const writes: unknown[] = [];
  const state = {
    missing: false, unavailable: false, uninitialized: false, authorityChanges: false,
    expiresAt: null as Date | null,
    observedAt: now,
    beforeAcquisition: null as null | (() => void),
    gatewayTimeout: null as null | Promise<void>,
    readSetting: null as null | Promise<void>,
    writeSetting: null as null | Promise<void>,
    result: { kind: "updated", revision: { ...revision, id: id(7), recordsPerRequest: 1_000 } } as ReviseProviderRequestSettingsResult,
  };
  const runtime = createDistributedProviderRequestSettingsRuntime({
    central: { providers: { async findFirst(query: unknown) {
      queries.push(query);
      if (state.missing) return null;
      return { id: id(3), provider_key: "phygitals", active_config_version: {
        id: state.authorityChanges && queries.length > 1 ? id(10) : id(4),
        version_number: 4n, adapter_key: revision.adapterKey, expires_at: state.expiresAt,
      } };
    } } } as unknown as CentralPrismaClient,
    gateway: { async runWithAdminProviderDatabase(route, operation) {
      routes.push(route);
      if (state.unavailable) return { state: "unreachable" } as never;
      state.beforeAcquisition?.();
      const pending = operation({} as ProviderPrismaClient);
      if (state.gatewayTimeout) {
        // Match the real gateway: time out without cancelling its callback.
        void pending.catch(() => undefined);
        await state.gatewayTimeout;
        return { state: "unreachable" } as never;
      }
      return { state: "reachable", providerId: id(3), observedAt: now.toISOString(), value: await pending };
    } },
    repository: () => ({
      async current(input) {
        assert.deepEqual(input, { providerId: id(3) });
        if (state.readSetting) await state.readSetting;
        return state.uninitialized ? null : revision;
      },
      async revise(input) {
        writes.push(input);
        if (state.writeSetting) await state.writeSetting;
        return state.result;
      },
    }),
    sourceIntegrations: createLaunchSourceIntegrationCapabilities(), correlationId: () => id(8), now: () => state.observedAt,
  });
  return { runtime, state, queries, routes, writes };
}

test("distributed request edit routes only actor organization and pins current authority without source/run mutation", async () => {
  const f = fixture();
  assert.deepEqual(await f.runtime.requestSettings.revise(command), { requestSettingsRevisionId: id(7), recordsPerRequest: 1_000 });
  assert.deepEqual(f.routes, [{ organizationId: id(1), providerId: id(3) }]);
  assert.deepEqual(f.queries[0], {
    where: { id: id(3), organization_id: id(1), lifecycle: { not: "archived" } },
    select: { id: true, provider_key: true, active_config_version: { select: { id: true, version_number: true, adapter_key: true, expires_at: true } } },
  });
  assert.deepEqual(f.writes, [{ providerId: id(3), expectedRevisionId: id(6), recordsPerRequest: 1_000,
    actorOperatorId: id(2), correlationId: id(8), expectedConfigVersionId: id(4), expectedConfigVersionNumber: 4n,
    adapterKey: revision.adapterKey, writeDeadline: new Date(now.getTime() + 10_000) }]);
  // Setting creation provenance differs intentionally: settings survive source config revisions.
  assert.notEqual(revision.configVersionId, command.request.expectedConfigVersionId);
});

test("distributed request edit fails closed for tenant miss, stale config, uninitialized and unreachable database", async () => {
  for (const key of ["missing", "unavailable", "uninitialized", "authorityChanges"] as const) {
    const f = fixture(); f.state[key] = true;
    await assert.rejects(f.runtime.requestSettings.revise(command));
    assert.equal(f.writes.length, 0, key);
    if (key === "missing") assert.equal(f.routes.length, 0);
  }
  for (const changed of [
    { ...command, request: { ...command.request, expectedConfigVersionId: id(11) } },
    { ...command, request: { ...command.request, recordsPerRequest: 0 } },
  ]) {
    const f = fixture(); await assert.rejects(f.runtime.requestSettings.revise(changed));
    assert.equal(f.writes.length, 0); assert.equal(f.routes.length, 0);
  }
  const expired = fixture(); expired.state.expiresAt = now;
  await assert.rejects(expired.runtime.requestSettings.revise(command));
  assert.equal(expired.routes.length, 0);
});

test("atomic request-setting CAS outcomes remain bounded instead of retrying or initializing", async () => {
  for (const kind of ["revision_conflict", "configuration_conflict", "identity_mismatch", "configuration_expired"] as const) {
    const f = fixture(); f.state.result = { kind };
    await assert.rejects(f.runtime.requestSettings.revise(command), {
      code: kind === "revision_conflict" ? "SOURCE_CONFLICT" : kind === "identity_mismatch" ? "SOURCE_OPERATIONS_UNAVAILABLE" : "SOURCE_REVISION_CONFLICT",
    });
    assert.equal(f.writes.length, 1);
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("request write budget includes gateway acquisition and never starts a write after expiry", async () => {
  const f = fixture();
  f.state.beforeAcquisition = () => { f.state.observedAt = new Date(now.getTime() + 10_000); };
  await assert.rejects(f.runtime.requestSettings.revise(command), { code: "SOURCE_OPERATIONS_UNAVAILABLE" });
  assert.equal(f.writes.length, 0);
});

test("gateway timeout during settings read revokes future writes and drains the callback before responding", async () => {
  const f = fixture();
  const timeout = deferred(); const read = deferred();
  f.state.gatewayTimeout = timeout.promise; f.state.readSetting = read.promise;
  let responded = false;
  const request = f.runtime.requestSettings.revise(command).finally(() => { responded = true; });
  const rejection = assert.rejects(request, { code: "SOURCE_OPERATIONS_UNAVAILABLE" });
  await tick(); timeout.resolve(); await tick();
  assert.equal(responded, false);
  assert.equal(f.writes.length, 0);
  read.resolve(); await rejection;
  assert.equal(responded, true);
  assert.equal(f.writes.length, 0);
});

test("gateway timeout during an admitted mutation waits for its definitive commit and acknowledges it", async () => {
  const f = fixture();
  const timeout = deferred(); const write = deferred();
  f.state.gatewayTimeout = timeout.promise; f.state.writeSetting = write.promise;
  let responded = false;
  const request = f.runtime.requestSettings.revise(command).finally(() => { responded = true; });
  await tick(); assert.equal(f.writes.length, 1);
  timeout.resolve(); await tick();
  assert.equal(responded, false);
  write.resolve();
  assert.deepEqual(await request, { requestSettingsRevisionId: id(7), recordsPerRequest: 1_000 });
  assert.equal(responded, true);
  assert.equal(f.writes.length, 1);
});

test("gateway timeout during a mutation rolled back by its deadline returns unavailable after settlement", async () => {
  const f = fixture();
  const timeout = deferred(); const write = deferred();
  f.state.gatewayTimeout = timeout.promise; f.state.writeSetting = write.promise;
  f.state.result = { kind: "write_deadline_expired" };
  let responded = false;
  const request = f.runtime.requestSettings.revise(command).finally(() => { responded = true; });
  const rejection = assert.rejects(request, { code: "SOURCE_OPERATIONS_UNAVAILABLE" });
  await tick(); timeout.resolve(); await tick();
  assert.equal(responded, false);
  write.resolve(); await rejection;
  assert.equal(responded, true);
  assert.equal(f.writes.length, 1);
});
