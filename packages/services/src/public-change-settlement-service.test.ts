import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PublicChangeSettlementService,
  PublicOrganizationConfigurationError,
  type PublicChangeSettlementReadPort,
} from "./public-change-settlement-service.ts";

const organizationId = "53000000-0000-4000-8000-000000000001";
const occurredAt = new Date("2026-08-15T03:00:00.000Z");

test("the settlement reader binds the configured PackScout organization and defaults to its checkpoint", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const repository: PublicChangeSettlementReadPort = {
    async getSettledWatermark(requestedOrganizationId) {
      calls.push({ method: "checkpoint", requestedOrganizationId });
      return {
        organizationId: requestedOrganizationId,
        settledSequence: 7n,
        settledAt: occurredAt,
        sourceHeadSequence: 9n,
        sourceHeadAt: occurredAt,
        sourceHeads: [],
      };
    },
    async listSettledCauses(input) {
      calls.push({ method: "changes", ...input });
      return [
        {
          organizationId: input.organizationId,
          sequence: 7n,
          changeKind: "provider_projection",
          entityKey: "canonical:v1:fixture",
          sourceKey: "fixture-provider",
          sourceRevisionKey: "revision-7",
          metadata: {},
          occurredAt,
          authoritativeTransactionId: "42",
        },
      ];
    },
  };
  const service = new PublicChangeSettlementService(repository, {
    organizationId: organizationId.toUpperCase(),
  });

  const changes = await service.listSettledChanges({
    afterSequence: 6n,
  });
  assert.equal(changes[0]?.sequence, 7n);
  assert.deepEqual(calls, [
    { method: "checkpoint", requestedOrganizationId: organizationId },
    {
      method: "changes",
      organizationId,
      afterSequence: 6n,
      throughSequence: 7n,
      limit: 500,
    },
  ]);
});

test("the settlement reader fails closed for invalid organization configuration and unsettled ranges", async () => {
  const repository: PublicChangeSettlementReadPort = {
    async getSettledWatermark(requestedOrganizationId) {
      return {
        organizationId: requestedOrganizationId,
        settledSequence: 2n,
        settledAt: occurredAt,
        sourceHeadSequence: 3n,
        sourceHeadAt: occurredAt,
        sourceHeads: [],
      };
    },
    async listSettledCauses() {
      throw new Error("must not read an unsettled range");
    },
  };
  assert.throws(
    () =>
      new PublicChangeSettlementService(repository, {
        organizationId: "caller-selected-tenant",
      }),
    (error: unknown) => error instanceof PublicOrganizationConfigurationError,
  );
  const service = new PublicChangeSettlementService(repository, {
    organizationId,
  });
  await assert.rejects(
    service.listSettledChanges({
      afterSequence: 0n,
      throughSequence: 3n,
    }),
    /beyond settlement/,
  );
});
