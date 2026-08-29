import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CentralQueryClient } from "./central-database.ts";
import {
  evaluateProviderDatabaseRoute,
  locateProviderDatabase,
} from "./provider-database-locator.ts";

const organizationId = "20000000-0000-4000-8000-000000000001";
const providerId = "20000000-0000-4000-8000-000000000002";

const validProvider = {
  id: providerId,
  organization_id: organizationId,
  provider_key: "alpha",
  lifecycle: "active" as const,
  topology_version: 3n,
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
        credential: { credential_kind: "database", lifecycle: "revoked" },
      }],
    }), { state: "unavailable", failureCode: "PROVIDER_DATABASE_CREDENTIAL_UNAVAILABLE" });
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
  });
});
