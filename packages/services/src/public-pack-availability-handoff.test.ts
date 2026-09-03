import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PUBLIC_PACK_AVAILABILITY_INPUT_VERSION,
  dataforrestEventRecordV1Schema,
  normalizeDataforrestEventRecord,
  projectCanonicalPackAvailabilityV1,
} from "@packscout/contracts";
import { dataforestEventsV1EvidenceFixture } from "@packscout/contracts/test-fixtures/dataforrest-events-v1";
import type { CanonicalObservationPackCandidate } from "./provider-observation-mapper.ts";
import { courtyardProviderObservationMapper } from "./providers/courtyard/mapper.ts";
import {
  mapperInput,
  packFacts,
  packObservation,
} from "./providers/provider-observation-mapper.test-support.ts";

const publicIdentity = {
  schemaVersion: PUBLIC_PACK_AVAILABILITY_INPUT_VERSION,
  publicRepackId: "00000000-0000-5000-8000-000000000301",
  publicVendorId: "00000000-0000-5000-8000-000000000001",
  vendorKey: "courtyard",
} as const;

function mappedPack(observation: ReturnType<typeof packObservation>) {
  const outcome = courtyardProviderObservationMapper.map(
    mapperInput("courtyard", observation),
  );
  assert.equal(outcome.status, "mapped");
  if (outcome.status !== "mapped" || outcome.candidate.candidateKind !== "pack") {
    assert.fail("Expected a canonical pack candidate.");
  }
  return outcome.candidate;
}

function projectObserved(candidate: CanonicalObservationPackCandidate) {
  assert.notEqual(candidate.availability, "sold_out");
  if (candidate.availability === "sold_out") assert.fail("Unexpected sold out.");
  return projectCanonicalPackAvailabilityV1({
    ...publicIdentity,
    availability: candidate.availability,
    availabilityProvenance: {
      kind: "canonical_provider_observation",
      observedAvailability: candidate.availability,
    },
    sourceUpdatedAt: candidate.effectiveAt,
  });
}

test("DataForrest true, false, and null stop at task-005 canonical mapping before public projection", () => {
  const initial = dataforestEventsV1EvidenceFixture.courtyard.initial.records[0];
  const disappeared =
    dataforestEventsV1EvidenceFixture.courtyard.continuation.records[0];
  const unknown = dataforrestEventRecordV1Schema.parse({
    ...initial,
    occurred_at: "2026-01-06T00:00:00.000Z",
    collected_at: "2026-01-06T00:00:01.000Z",
    available: null,
  });
  const reappeared = dataforrestEventRecordV1Schema.parse({
    ...disappeared,
    occurred_at: "2026-01-07T00:00:00.000Z",
    collected_at: "2026-01-07T00:00:01.000Z",
    available: true,
  });

  const outputs = [initial, disappeared, unknown, reappeared].map(
    (record, index) => {
      const parsed = dataforrestEventRecordV1Schema.parse(record);
      const normalized = normalizeDataforrestEventRecord(
        parsed,
        "courtyard",
        `protected:evidence:${index}`,
      );
      const outcome = courtyardProviderObservationMapper.map(
        mapperInput("courtyard", normalized),
      );
      assert.equal(outcome.status, "mapped");
      if (
        outcome.status !== "mapped" ||
        outcome.candidate.candidateKind !== "pack"
      ) {
        assert.fail("Expected a canonical pack candidate.");
      }
      return projectObserved(outcome.candidate);
    },
  );

  assert.deepEqual(
    outputs.map(({ availability }) => availability),
    ["available", "unavailable", "unknown", "available"],
  );
  assert.equal(JSON.stringify(outputs).includes("sold_out"), false);
  assert.equal(JSON.stringify(outputs).includes("protected:evidence"), false);
});

test("only an explicit task-005 authority can hand sold out to the public boundary", () => {
  const candidate = mappedPack(
    packObservation({
      availability: "unavailable",
      providerFacts: packFacts({
        authoritativeAvailability: {
          state: "present",
          value: {
            state: "sold_out",
            authority: "provider_explicit_sold_out",
          },
        },
      }),
    }),
  );
  assert.equal(candidate.availability, "sold_out");
  const projected = projectCanonicalPackAvailabilityV1({
    ...publicIdentity,
    availability: candidate.availability,
    availabilityProvenance: {
      kind: "explicit_authoritative_sold_out",
      authority: "provider_explicit_sold_out",
    },
    sourceUpdatedAt: candidate.effectiveAt,
  });
  assert.equal(projected.availability, "sold_out");
});
