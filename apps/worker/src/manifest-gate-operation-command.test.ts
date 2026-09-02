import assert from "node:assert/strict";
import test from "node:test";
import type { ManifestGateIntent } from "@packscout/database";
import {
  DistributedManifestGateOperationCommandError,
  readDistributedManifestGateOperationCommandConfiguration,
  runDistributedManifestGateOperationCommand,
} from "./manifest-gate-operation-command.ts";

const providerId = "00000000-0000-4000-8000-000000000101";
const releaseId = "00000000-0000-4000-8000-000000000102";
const catalogId = "00000000-0000-4000-8000-000000000103";
const operatorId = "00000000-0000-4000-8000-000000000104";
const requestedAt = "2026-09-01T12:00:00.000Z";
const authorizationDigest = "a".repeat(64);
const clock = () => new Date("2026-09-01T12:01:00.000Z");

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    PACKSCOUT_DISTRIBUTED_PROMOTION_MODE: "split",
    PACKSCOUT_DISTRIBUTED_MANIFEST_OPERATION: "rollback",
    PACKSCOUT_DISTRIBUTED_MANIFEST_OPERATION_PROVIDER_ID: providerId,
    PACKSCOUT_DISTRIBUTED_MANIFEST_OPERATION_PROVIDER_RELEASE_ID: releaseId,
    PACKSCOUT_DISTRIBUTED_MANIFEST_OPERATION_CATALOG_VERSION_ID: catalogId,
    PACKSCOUT_DISTRIBUTED_MANIFEST_OPERATION_OPERATOR_ID: operatorId,
    PACKSCOUT_DISTRIBUTED_MANIFEST_OPERATION_AUTHORIZATION_SHA256:
      authorizationDigest,
    PACKSCOUT_DISTRIBUTED_MANIFEST_OPERATION_REQUESTED_AT: requestedAt,
    ...overrides,
  };
}

function hasCode(
  code: DistributedManifestGateOperationCommandError["code"],
) {
  return (error: unknown) =>
    error instanceof DistributedManifestGateOperationCommandError &&
    error.code === code;
}

test("reads one exact central-only explicit manifest operation", () => {
  assert.deepEqual(
    readDistributedManifestGateOperationCommandConfiguration(
      environment(),
      clock,
    ),
    {
      providerId,
      operation: "rollback",
      targetProviderReleaseId: releaseId,
      targetCatalogVersionId: catalogId,
      requestedByOperatorId: operatorId,
      authorizationDigest,
      requestedAt: new Date(requestedAt),
    },
  );
  const remove = readDistributedManifestGateOperationCommandConfiguration(
    environment({
      PACKSCOUT_DISTRIBUTED_MANIFEST_OPERATION: "remove",
      PACKSCOUT_DISTRIBUTED_MANIFEST_OPERATION_PROVIDER_RELEASE_ID: undefined,
      PACKSCOUT_DISTRIBUTED_MANIFEST_OPERATION_CATALOG_VERSION_ID: undefined,
    }),
    clock,
  );
  assert.deepEqual(
    [remove.targetProviderReleaseId, remove.targetCatalogVersionId],
    [null, null],
  );
});

test("refuses target ambiguity, provider authority, and non-split mode", () => {
  for (const [overrides, code] of [
    [{ PACKSCOUT_DISTRIBUTED_MANIFEST_OPERATION_CATALOG_VERSION_ID: undefined },
      "DISTRIBUTED_MANIFEST_OPERATION_INPUT_INVALID"],
    [{ PACKSCOUT_PROVIDER_DATABASE_URL: "postgresql://provider/db" },
      "DISTRIBUTED_MANIFEST_OPERATION_AUTHORITY_CONFLICT"],
    [{ PACKSCOUT_PROMOTION_MANIFEST_SECRET_BASE64: "publication-secret" },
      "DISTRIBUTED_MANIFEST_OPERATION_AUTHORITY_CONFLICT"],
    [{ PACKSCOUT_DISTRIBUTED_PROMOTION_MODE: "legacy" },
      "DISTRIBUTED_MANIFEST_OPERATION_ENVIRONMENT_INVALID"],
    [{ PACKSCOUT_DISTRIBUTED_MANIFEST_OPERATION_REQUESTED_AT:
      "2026-09-01T11:55:59.999Z" },
    "DISTRIBUTED_MANIFEST_OPERATION_INPUT_INVALID"],
    [{ PACKSCOUT_DISTRIBUTED_MANIFEST_OPERATION_REQUESTED_AT:
      "2026-09-01T12:01:30.001Z" },
    "DISTRIBUTED_MANIFEST_OPERATION_INPUT_INVALID"],
  ] as const) {
    assert.throws(
      () => readDistributedManifestGateOperationCommandConfiguration(
        environment(overrides),
        clock,
      ),
      hasCode(code),
    );
  }
});

test("authorizes exact replay-safe intent and returns only bounded evidence", async () => {
  const configuration =
    readDistributedManifestGateOperationCommandConfiguration(
      environment(),
      clock,
    );
  let observed: unknown;
  const result = await runDistributedManifestGateOperationCommand({
    async authorizeExplicit(input) {
      observed = input;
      return {
        requestedOperation: "rollback",
        authorizationDigest,
        pending: true,
        operationGeneration: 8n,
      } as ManifestGateIntent;
    },
  }, configuration);
  assert.deepEqual(observed, configuration);
  assert.deepEqual(result, {
    status: "authorized",
    operation: "rollback",
    requestedGeneration: "8",
    pending: true,
    authorizationDigest,
  });
  const rendered = JSON.stringify(result);
  assert.doesNotMatch(rendered, new RegExp(providerId, "u"));
  assert.doesNotMatch(rendered, new RegExp(operatorId, "u"));
});
