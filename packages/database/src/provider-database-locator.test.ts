import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CentralQueryClient } from "./central-database.ts";
import {
  evaluateProviderActivationTestRoute,
  evaluateProviderDatabaseRoute,
  locateProviderActivationTestDatabase,
  locateProviderDatabase,
} from "./provider-database-locator.ts";

const organizationId = "20000000-0000-4000-8000-000000000001";
const providerId = "20000000-0000-4000-8000-000000000002";
const configVersionId = "20000000-0000-4000-8000-000000000005";

const validProvider = {
  id: providerId,
  organization_id: organizationId,
  provider_key: "alpha",
  lifecycle: "active" as const,
  active_config_version_id: configVersionId,
  active_config_version: { id: configVersionId, expires_at: null },
  topology_version: 3n,
  row_version: 4n,
  config_versions: [{ id: configVersionId, expires_at: null }],
  database_nodes: [{
    id: "20000000-0000-4000-8000-000000000003",
    host: "alpha.internal",
    port: 5432,
    database_name: "packscout_alpha",
    ssl_mode: "verify-full",
    credential_version_id: "20000000-0000-4000-8000-000000000004",
    row_version: 2n,
    credential: {
      credential_kind: "database" as const,
      lifecycle: "active" as const,
      ciphertext: new Uint8Array([1]),
      nonce: new Uint8Array(12),
      auth_tag: new Uint8Array(16),
      key_version: 1,
    },
  }],
};

describe("provider database locator", () => {
  test("derives an exact route from central registry state", () => {
    const result = evaluateProviderDatabaseRoute(validProvider);
    assert.equal(result.state, "ready");
    if (result.state === "ready") {
      assert.equal(result.route.target.databaseName, "packscout_alpha");
      assert.equal(result.route.topologyVersion, 3n);
      assert.equal(result.route.node.credentialVersionId, validProvider.database_nodes[0]!.credential_version_id);
    }
  });

  test("fails closed for inactive, ambiguous, mismatched, or unusable routes", () => {
    assert.deepEqual(evaluateProviderDatabaseRoute({
      ...validProvider,
      active_config_version: {
        id: configVersionId,
        expires_at: new Date("2026-08-29T11:59:59.999Z"),
      },
    }, new Date("2026-08-29T12:00:00.000Z")), {
      state: "unavailable",
      failureCode: "PROVIDER_CONFIG_EXPIRED",
    });
    assert.deepEqual(evaluateProviderDatabaseRoute({
      ...validProvider,
      active_config_version: null,
    }), { state: "unavailable", failureCode: "PROVIDER_NOT_ROUTABLE" });
    assert.deepEqual(evaluateProviderDatabaseRoute({
      ...validProvider,
      lifecycle: "disabled",
    }), { state: "unavailable", failureCode: "PROVIDER_NOT_ROUTABLE" });
    assert.deepEqual(evaluateProviderDatabaseRoute({
      ...validProvider,
      database_nodes: [...validProvider.database_nodes, validProvider.database_nodes[0]!],
    }), { state: "unavailable", failureCode: "PROVIDER_DATABASE_NODE_UNAVAILABLE" });
    assert.deepEqual(evaluateProviderDatabaseRoute({
      ...validProvider,
      database_nodes: [{ ...validProvider.database_nodes[0]!, database_name: "packscout_beta" }],
    }), { state: "unavailable", failureCode: "PROVIDER_DATABASE_NAME_MISMATCH" });
    assert.deepEqual(evaluateProviderDatabaseRoute({
      ...validProvider,
      database_nodes: [{
        ...validProvider.database_nodes[0]!,
        credential: {
          ...validProvider.database_nodes[0]!.credential,
          lifecycle: "revoked",
        },
      }],
    }), { state: "unavailable", failureCode: "PROVIDER_DATABASE_CREDENTIAL_UNAVAILABLE" });
  });

  test("resolves an exact draft activation target but rejects stale CAS values", () => {
    const draft = { ...validProvider, lifecycle: "draft" as const };
    assert.equal(evaluateProviderActivationTestRoute(draft, {
      expectedConfigVersionId: configVersionId,
      expectedRowVersion: 4n,
    }).state, "ready");
    assert.deepEqual(evaluateProviderActivationTestRoute(draft, {
      expectedConfigVersionId: "20000000-0000-4000-8000-000000000006",
      expectedRowVersion: 4n,
    }), {
      state: "unavailable",
      failureCode: "PROVIDER_CONFIG_VERSION_CONFLICT",
    });
    assert.deepEqual(evaluateProviderActivationTestRoute(draft, {
      expectedConfigVersionId: configVersionId,
      expectedRowVersion: 3n,
    }), {
      state: "unavailable",
      failureCode: "PROVIDER_ROW_VERSION_CONFLICT",
    });
  });

  test("queries by authenticated organization and provider IDs only", async () => {
    let receivedWhere: unknown;
    const central = {
      providers: {
        async findUnique(input: { where: unknown }) {
          receivedWhere = input.where;
          return validProvider;
        },
      },
    } as unknown as CentralQueryClient;

    const result = await locateProviderDatabase(central, {
      organizationId,
      providerId,
    });
    assert.equal(result.state, "ready");
    assert.deepEqual(receivedWhere, {
      id_organization_id: { id: providerId, organization_id: organizationId },
    });
    await assert.rejects(
      locateProviderDatabase(central, { organizationId: "other", providerId }),
      /Organization ID is invalid/,
    );

    const activation = await locateProviderActivationTestDatabase(central, {
      organizationId,
      providerId,
      expectedConfigVersionId: configVersionId,
      expectedRowVersion: 4n,
    });
    assert.equal(activation.state, "ready");
  });
});
