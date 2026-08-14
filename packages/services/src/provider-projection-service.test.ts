import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderProjectionPort } from "./provider-import-types.ts";
import { ProviderProjectionService } from "./provider-projection-service.ts";

const source = {
  platform: "fixture",
  recordKind: "catalog" as const,
  recordIndex: 0,
  externalId: "source-1",
  sourceTimestamp: "2026-08-06T00:00:00.000Z",
  collectedAt: "2026-08-06T00:01:00.000Z",
};
const configuration = {
  providerId: "provider-1",
  configurationRevisionId: "revision-1",
  platform: "fixture",
  adapterKey: "fixture-v1",
};

function trackingPort(label: string, calls: string[]): ProviderProjectionPort {
  return {
    project: () => {
      calls.push(label);
      return { status: "accepted", projections: [] };
    },
  };
}

test("projection composition routes provider-neutral candidate families without platform branches", async () => {
  const calls: string[] = [];
  const service = new ProviderProjectionService(
    trackingPort("catalog", calls),
    trackingPort("event", calls),
  );
  const base = {
    source,
    relationships: [],
    dataQualityEvidence: [],
  };
  assert.equal(
    (
      await service.project({
        configuration,
        source,
        candidates: [
          {
            ...base,
            candidateKind: "pack",
            externalId: "pack-1",
            parentExternalId: null,
            name: "Pack",
            availability: "active",
          },
        ],
      })
    ).status,
    "accepted",
  );
  const pullSource = { ...source, recordKind: "pull" as const };
  assert.equal(
    (
      await service.project({
        configuration,
        source: pullSource,
        candidates: [
          {
            ...base,
            source: pullSource,
            candidateKind: "pull",
            packExternalId: null,
            assetExternalId: null,
            occurredAt: pullSource.sourceTimestamp,
            pseudonymizationInputs: [],
          },
        ],
      })
    ).status,
    "accepted",
  );
  const tradeSource = { ...source, recordKind: "trade" as const };
  assert.equal(
    (
      await service.project({
        configuration,
        source: tradeSource,
        candidates: [
          {
            ...base,
            source: tradeSource,
            candidateKind: "trade",
            eventType: "sale",
            transactionKey: "transaction-1",
            assetExternalId: null,
            occurredAt: tradeSource.sourceTimestamp,
            amount: null,
            paymentMethod: null,
            pseudonymizationInputs: [],
          },
        ],
      })
    ).status,
    "accepted",
  );
  assert.deepEqual(calls, ["catalog", "event", "event"]);
});

test("projection composition rejects empty or mixed families before either handler", async () => {
  const calls: string[] = [];
  const service = new ProviderProjectionService(
    trackingPort("catalog", calls),
    trackingPort("event", calls),
  );
  const empty = await service.project({ configuration, source, candidates: [] });
  assert.deepEqual(empty, {
    status: "invalid",
    reasonCode: "PROJECTION_CANDIDATE_SET_EMPTY",
    fieldPath: "candidates",
  });
  const mixed = await service.project({
    configuration,
    source,
    candidates: [
      {
        candidateKind: "catalog_asset",
        source,
        externalId: "asset-1",
        relationships: [],
        dataQualityEvidence: [],
      },
      {
        candidateKind: "trade",
        source: { ...source, recordKind: "trade" },
        eventType: "sale",
        transactionKey: "tx-1",
        assetExternalId: null,
        occurredAt: source.sourceTimestamp,
        amount: null,
        paymentMethod: null,
        pseudonymizationInputs: [],
        relationships: [],
        dataQualityEvidence: [],
      },
    ],
  });
  assert.equal(mixed.status, "invalid");
  if (mixed.status === "invalid") {
    assert.equal(mixed.reasonCode, "PROJECTION_CANDIDATE_SET_MIXED");
  }
  assert.deepEqual(calls, []);
});
