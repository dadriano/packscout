import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REPACK_HEAT_AGGREGATION_VERSION,
  REPACK_HEAT_POLICY_VERSION,
} from "@packscout/contracts";
import {
  NORMALIZED_HEAT_OBSERVATION_VERSION,
  type NormalizedHeatObservation,
} from "./normalized-heat-observation-contracts.ts";
import {
  NormalizedHeatObservationService,
  NormalizedHeatReadError,
  buildNormalizedHeatFrameWindows,
  type NormalizedHeatObservationPage,
  type NormalizedHeatObservationQuery,
  type NormalizedHeatObservationReadPort,
} from "./normalized-heat-observation-port.ts";
import { calculateRepackHeat } from "./repack-heat-calculator.ts";

const organizationId = "55000000-0000-4000-8000-000000000001";
const firstRepackId = "55000000-0000-5000-8000-000000000001";
const secondRepackId = "55000000-0000-5000-8000-000000000002";
const frameEndedAt = "2026-08-15T12:00:00.000Z";
const baselineStartedAt = "2026-08-14T11:45:00.000Z";
const currentStartedAt = "2026-08-15T11:45:00.000Z";

function pull(
  overrides: Partial<Extract<NormalizedHeatObservation, { kind: "pull" }>> = {},
): NormalizedHeatObservation {
  return {
    schemaVersion: NORMALIZED_HEAT_OBSERVATION_VERSION,
    kind: "pull",
    observationKey: "a".repeat(64),
    publicRepackId: firstRepackId,
    occurredAt: baselineStartedAt,
    causalSequence: 10n,
    realizedReturnBasisPoints: null,
    valueMultipleBasisPoints: 0,
    ...overrides,
  };
}

function catalog(
  overrides: Partial<
    Extract<NormalizedHeatObservation, { kind: "catalog_snapshot" }>
  > = {},
): NormalizedHeatObservation {
  return {
    schemaVersion: NORMALIZED_HEAT_OBSERVATION_VERSION,
    kind: "catalog_snapshot",
    observationKey: "b".repeat(64),
    publicRepackId: firstRepackId,
    occurredAt: currentStartedAt,
    causalSequence: 11n,
    catalogSequence: 2,
    availableChaseCount: 3,
    outcomeKeys: ["alpha", "beta"],
    ...overrides,
  };
}

class RecordingRepository implements NormalizedHeatObservationReadPort {
  queries: NormalizedHeatObservationQuery[] = [];

  constructor(private readonly page: NormalizedHeatObservationPage) {}

  listSettledNormalizedHeatObservations(
    query: NormalizedHeatObservationQuery,
  ): Promise<NormalizedHeatObservationPage> {
    this.queries.push(query);
    return Promise.resolve(this.page);
  }
}

function service(page: NormalizedHeatObservationPage) {
  const repository = new RecordingRepository(page);
  return {
    repository,
    subject: new NormalizedHeatObservationService(repository, {
      organizationId,
    }),
  };
}

function invalidResult(error: unknown) {
  return (
    error instanceof NormalizedHeatReadError &&
    error.code === "NORMALIZED_HEAT_RESULT_INVALID"
  );
}

test("builds the contiguous half-open 24-hour baseline and 15-minute current windows", () => {
  assert.deepEqual(buildNormalizedHeatFrameWindows(frameEndedAt), {
    baselineWindow: {
      startAt: baselineStartedAt,
      endAt: currentStartedAt,
    },
    currentWindow: {
      startAt: currentStartedAt,
      endAt: frameEndedAt,
    },
    occurredAtGte: baselineStartedAt,
    occurredAtLt: frameEndedAt,
  });
});

test("binds organization server-side and returns only calculator observations and coverage flags", async () => {
  const { repository, subject } = service({
    observations: [
      catalog(),
      pull(),
      pull({
        observationKey: "c".repeat(64),
        publicRepackId: secondRepackId,
        occurredAt: "2026-08-15T11:59:59.999Z",
        causalSequence: 12n,
      }),
    ],
    sourceCoverageComplete: false,
    truncated: true,
  });

  const result = await subject.readFrame({
    publicRepackIds: [secondRepackId, firstRepackId],
    frameEndedAt,
    maximumSettledCausalSequence: 12n,
    limit: 3,
  });

  assert.deepEqual(repository.queries, [
    {
      organizationId,
      publicRepackIds: [firstRepackId, secondRepackId],
      occurredAtGte: baselineStartedAt,
      occurredAtLt: frameEndedAt,
      causalSequenceLte: 12n,
      limit: 3,
    },
  ]);
  assert.deepEqual(Object.keys(result).sort(), [
    "observations",
    "sourceCoverageComplete",
    "truncated",
  ]);
  assert.deepEqual(
    result.observations.map((observation) => observation.kind),
    ["pull", "catalog_snapshot", "pull"],
  );
  assert.equal(result.sourceCoverageComplete, false);
  assert.equal(result.truncated, true);
  const serialized = JSON.stringify(result).toLowerCase();
  for (const protectedName of [
    "organization",
    "tenant",
    "provider",
    "actor",
    "raw",
    "causalsequence",
    "observationkey",
  ]) {
    assert.equal(serialized.includes(protectedName), false);
  }
});

test("includes the lower time boundary and excludes the upper boundary", async () => {
  const accepted = service({
    observations: [
      pull(),
      pull({
        observationKey: "c".repeat(64),
        occurredAt: "2026-08-15T11:59:59.999Z",
      }),
    ],
    sourceCoverageComplete: true,
    truncated: false,
  });
  assert.equal(
    (
      await accepted.subject.readFrame({
        publicRepackIds: [firstRepackId],
        frameEndedAt,
        maximumSettledCausalSequence: 10n,
      })
    ).observations.length,
    2,
  );

  const excluded = service({
    observations: [pull({ occurredAt: frameEndedAt })],
    sourceCoverageComplete: true,
    truncated: false,
  });
  await assert.rejects(
    () =>
      excluded.subject.readFrame({
        publicRepackIds: [firstRepackId],
        frameEndedAt,
        maximumSettledCausalSequence: 10n,
      }),
    invalidResult,
  );
});

test("defensively excludes observations above the settled watermark", async () => {
  const leaked = service({
    observations: [pull({ causalSequence: 11n })],
    sourceCoverageComplete: true,
    truncated: false,
  });
  await assert.rejects(
    () =>
      leaked.subject.readFrame({
        publicRepackIds: [firstRepackId],
        frameEndedAt,
        maximumSettledCausalSequence: 10n,
      }),
    invalidResult,
  );

  const settled = service({
    observations: [pull({ causalSequence: 11n })],
    sourceCoverageComplete: true,
    truncated: false,
  });
  assert.equal(
    (
      await settled.subject.readFrame({
        publicRepackIds: [firstRepackId],
        frameEndedAt,
        maximumSettledCausalSequence: 11n,
      })
    ).observations.length,
    1,
  );
});

test("rejects duplicate replay keys instead of double-counting them", async () => {
  const replayed = pull();
  const { subject } = service({
    observations: [replayed, { ...replayed }],
    sourceCoverageComplete: true,
    truncated: false,
  });

  await assert.rejects(
    () =>
      subject.readFrame({
        publicRepackIds: [firstRepackId],
        frameEndedAt,
        maximumSettledCausalSequence: 10n,
      }),
    invalidResult,
  );
});

test("orders equal-time catalog snapshots repeatably by bounded sequence", async () => {
  const ninth = catalog({
    observationKey: "d".repeat(64),
    catalogSequence: 9,
  });
  const eighth = catalog({
    observationKey: "e".repeat(64),
    catalogSequence: 8,
  });
  const first = service({
    observations: [ninth, eighth],
    sourceCoverageComplete: true,
    truncated: false,
  });
  const second = service({
    observations: [eighth, ninth],
    sourceCoverageComplete: true,
    truncated: false,
  });
  const input = {
    publicRepackIds: [firstRepackId],
    frameEndedAt,
    maximumSettledCausalSequence: 11n,
  } as const;

  const firstRead = await first.subject.readFrame(input);
  const secondRead = await second.subject.readFrame(input);
  assert.deepEqual(firstRead, secondRead);
  assert.deepEqual(
    firstRead.observations.map((observation) =>
      observation.kind === "catalog_snapshot" ? observation.sequence : null,
    ),
    [8, 9],
  );
  const calculatorInput = {
    publicRepackIds: [firstRepackId],
    observations: firstRead.observations,
    baselineWindow: {
      startAt: baselineStartedAt,
      endAt: currentStartedAt,
    },
    currentWindow: {
      startAt: currentStartedAt,
      endAt: frameEndedAt,
    },
    provenance: {
      kind: "observed" as const,
      aggregationVersion: REPACK_HEAT_AGGREGATION_VERSION,
    },
    heatPolicyVersion: REPACK_HEAT_POLICY_VERSION,
    sourceCoverageComplete: firstRead.sourceCoverageComplete,
    calculatedAt: frameEndedAt,
    expiresAt: "2026-08-15T12:15:00.000Z",
  };
  assert.deepEqual(
    calculateRepackHeat(calculatorInput),
    calculateRepackHeat(calculatorInput),
  );
});

test("rejects repository boundary violations and unbounded queries", async () => {
  const cases: readonly NormalizedHeatObservationPage[] = [
    {
      observations: [pull({ publicRepackId: secondRepackId })],
      sourceCoverageComplete: true,
      truncated: false,
    },
    {
      observations: [
        catalog(),
        catalog({ observationKey: "f".repeat(64) }),
      ],
      sourceCoverageComplete: true,
      truncated: false,
    },
    {
      observations: [pull(), pull({ observationKey: "0".repeat(64) })],
      sourceCoverageComplete: true,
      truncated: false,
    },
  ];
  for (const page of cases) {
    const { subject } = service(page);
    await assert.rejects(
      () =>
        subject.readFrame({
          publicRepackIds: [firstRepackId],
          frameEndedAt,
          maximumSettledCausalSequence: 11n,
          limit: 1,
        }),
      invalidResult,
    );
  }

  const { subject } = service({
    observations: [],
    sourceCoverageComplete: true,
    truncated: false,
  });
  for (const input of [
    {
      publicRepackIds: [] as string[],
      frameEndedAt,
      maximumSettledCausalSequence: 1n,
    },
    {
      publicRepackIds: [firstRepackId, firstRepackId],
      frameEndedAt,
      maximumSettledCausalSequence: 1n,
    },
    {
      publicRepackIds: [firstRepackId],
      frameEndedAt: "2026-08-15T12:00:00Z",
      maximumSettledCausalSequence: 1n,
    },
    {
      publicRepackIds: [firstRepackId],
      frameEndedAt,
      maximumSettledCausalSequence: -1n,
    },
    {
      publicRepackIds: [firstRepackId],
      frameEndedAt,
      maximumSettledCausalSequence: 1n,
      limit: 0,
    },
  ]) {
    await assert.rejects(
      () => subject.readFrame(input),
      (error: unknown) =>
        error instanceof NormalizedHeatReadError &&
        error.code === "NORMALIZED_HEAT_QUERY_INVALID",
    );
  }
});
