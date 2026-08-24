import assert from "node:assert/strict";
import { test } from "node:test";
import { createAdminProviderSourceRuntime } from "./provider-source-runtime.ts";

const organizationId = "00000000-0000-4000-8000-000000000001";
const operatorId = "00000000-0000-4000-8000-000000000002";

function runtime(actorKey = new Uint8Array(32).fill(7)) {
  return createAdminProviderSourceRuntime({
    database: {} as never,
    connectionConfigurationKey: new Uint8Array(32).fill(9),
    connectionConfigurationKeyVersion: 7,
    actorPseudonymKey: actorKey,
  });
}

test("production runtime exposes one DataForrest source type and rejects alternate adapter input before persistence", async () => {
  const production = runtime();
  await assert.rejects(
    production.connections.createProfile(
      { organizationId, actorKey: "actor:v1:safe" },
      {
        sourceTypeKey: "alternate-test-adapter" as "dataforrest-events-v1",
        displayName: "Not production",
        endpoint: "https://alternate.invalid/events",
        bearerCredential: "secret",
        requestLimit: 2,
      },
    ),
    (error: unknown) =>
      typeof error === "object" && error !== null &&
      "code" in error && error.code === "INVALID_SOURCE_CONFIGURATION",
  );
});

test("admin actor evidence is deterministic, tenant-bound, and does not contain operator identity", () => {
  const keyer = runtime().actorKeyer;
  const first = keyer.keyFor({ organizationId, operatorId });
  const repeated = keyer.keyFor({ organizationId, operatorId });
  const otherTenant = keyer.keyFor({
    organizationId: "00000000-0000-4000-8000-000000000003",
    operatorId,
  });
  assert.equal(first, repeated);
  assert.notEqual(first, otherTenant);
  assert.match(first, /^actor:v1:[a-f0-9]{64}$/u);
  assert.equal(first.includes(operatorId), false);
  assert.throws(
    () => runtime(new Uint8Array(31)),
    /actor key must be at least 32 bytes/u,
  );
  assert.throws(
    () => createAdminProviderSourceRuntime({
      database: {} as never,
      connectionConfigurationKey: new Uint8Array(32).fill(9),
      connectionConfigurationKeyVersion: 0,
      actorPseudonymKey: new Uint8Array(32).fill(7),
    }),
    /keyring is invalid|primary key version is unavailable/u,
  );
});
