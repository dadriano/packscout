import {
  REPACK_HEAT_SCENARIO_VERSION,
  parseRepackHeatTimestampMillis,
  type PublicRepackHeatSignal,
} from "@packscout/contracts";
import {
  REPACK_HEAT_AGGREGATION_VERSION,
  REPACK_HEAT_POLICY_VERSION,
  calculateRepackHeat,
  type RepackHeatObservation,
} from "@packscout/services/repack-heat-calculator";
import { sha256CanonicalJson } from "./dataReleaseCanonicalHash";
import {
  MOCK_DATA_RELEASE_PUBLIC_ID,
  buildMockDataReleaseV2,
} from "./mockDataReleaseFixture";

export const MOCK_HEAT_SCENARIO_VERSION = REPACK_HEAT_SCENARIO_VERSION;
export const MOCK_HEAT_AGGREGATION_VERSION =
  REPACK_HEAT_AGGREGATION_VERSION;
export const MOCK_HEAT_POLICY_VERSION = REPACK_HEAT_POLICY_VERSION;
export const MOCK_HEAT_CURRENT_WINDOW_MILLISECONDS = 15 * 60 * 1_000;
export const MOCK_HEAT_BASELINE_WINDOW_MILLISECONDS = 24 * 60 * 60 * 1_000;
export const MOCK_HEAT_EXPIRY_MILLISECONDS = 15 * 60 * 1_000;
export const MOCK_HEAT_DEFAULT_FRAME_STEP_MILLISECONDS = 5 * 60 * 1_000;
export const MOCK_HEAT_DEFAULT_PUBLICATION_CADENCE_MILLISECONDS = 5_000;
export const MOCK_HEAT_FRAME_HASH_DOMAIN =
  "packscout.mock.repack-heat-frame.v1" as const;
const MOCK_HEAT_RUN_HASH_DOMAIN =
  "packscout.mock.repack-heat-run.v1" as const;

export interface MockHeatSimulationControls {
  readonly seed: string;
  readonly startAt: string;
  readonly frameIndex: number;
  readonly frameStepMilliseconds: number;
  readonly publicationCadenceMilliseconds: number;
}

export interface MockHeatFrame {
  readonly publicReleaseId: typeof MOCK_DATA_RELEASE_PUBLIC_ID;
  readonly publicHeatSnapshotId: string;
  readonly simulationRunId: string;
  readonly sequence: number;
  readonly sourceKind: "simulated";
  readonly scenarioVersion: typeof MOCK_HEAT_SCENARIO_VERSION;
  readonly aggregationVersion: typeof REPACK_HEAT_AGGREGATION_VERSION;
  readonly heatPolicyVersion: typeof REPACK_HEAT_POLICY_VERSION;
  readonly calculatedAt: string;
  readonly expiresAt: string;
  readonly signals: readonly PublicRepackHeatSignal[];
  readonly contentHash: string;
}

function canonicalTimestamp(value: string, field: string): number {
  const parsed = parseRepackHeatTimestampMillis(value);
  if (parsed === null) {
    throw new RangeError(`${field} must be a canonical UTC timestamp.`);
  }
  return parsed;
}

export function validateMockHeatControls(
  input: MockHeatSimulationControls,
): MockHeatSimulationControls {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(input.seed)) {
    throw new RangeError("Simulation seed is invalid.");
  }
  canonicalTimestamp(input.startAt, "startAt");
  if (
    !Number.isSafeInteger(input.frameIndex) ||
    input.frameIndex < 0 ||
    input.frameIndex > 100_000
  ) {
    throw new RangeError("Simulation frame index is invalid.");
  }
  if (
    !Number.isSafeInteger(input.frameStepMilliseconds) ||
    input.frameStepMilliseconds < 60_000 ||
    input.frameStepMilliseconds > 3_600_000
  ) {
    throw new RangeError("Simulation frame step is invalid.");
  }
  if (
    !Number.isSafeInteger(input.publicationCadenceMilliseconds) ||
    input.publicationCadenceMilliseconds < 1_000 ||
    input.publicationCadenceMilliseconds > 60_000
  ) {
    throw new RangeError("Simulation publication cadence is invalid.");
  }
  return Object.freeze({ ...input });
}

function hashText(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function unit(seed: string): number {
  return hashText(seed) / 0x1_0000_0000;
}

function iso(value: number): string {
  return new Date(value).toISOString();
}

function pulls(input: {
  publicRepackId: string;
  seed: string;
  count: number;
  start: number;
  duration: number;
  returnBasisPoints: number;
  hitEvery: number | null;
}): RepackHeatObservation[] {
  return Array.from({ length: input.count }, (_, index) => {
    const interval = input.duration / input.count;
    const jitter = (unit(`${input.seed}:time:${index}`) - 0.5) * interval * 0.5;
    const occurredAt = Math.floor(
      input.start + interval * (index + 0.5) + jitter,
    );
    const returnJitter = Math.floor(
      (unit(`${input.seed}:return:${index}`) - 0.5) * 400,
    );
    return {
      kind: "pull" as const,
      publicRepackId: input.publicRepackId,
      occurredAt: iso(occurredAt),
      realizedReturnBasisPoints: Math.max(
        0,
        input.returnBasisPoints + returnJitter,
      ),
      valueMultipleBasisPoints:
        input.hitEvery !== null && index % input.hitEvery === 0
          ? 30_000
          : 10_000,
    };
  });
}

type ScenarioProfile = Readonly<{
  currentPullCount: number;
  returnBasisPoints: number;
  hitEvery: number | null;
  currentChaseCount: number;
  currentOutcomes: readonly string[];
}>;

const scenarioProfiles: readonly ScenarioProfile[] = Object.freeze([
  Object.freeze({
    currentPullCount: 20,
    returnBasisPoints: 15_000,
    hitEvery: 2,
    currentChaseCount: 4,
    currentOutcomes: Object.freeze(["a", "b", "c", "d"]),
  }),
  Object.freeze({
    currentPullCount: 12,
    returnBasisPoints: 10_000,
    hitEvery: 5,
    currentChaseCount: 3,
    currentOutcomes: Object.freeze(["a", "b", "c"]),
  }),
  Object.freeze({
    currentPullCount: 5,
    returnBasisPoints: 10_000,
    hitEvery: 5,
    currentChaseCount: 3,
    currentOutcomes: Object.freeze(["a", "b", "c"]),
  }),
  Object.freeze({
    currentPullCount: 5,
    returnBasisPoints: 5_000,
    hitEvery: null,
    currentChaseCount: 2,
    currentOutcomes: Object.freeze(["a", "b"]),
  }),
  Object.freeze({
    currentPullCount: 3,
    returnBasisPoints: 10_000,
    hitEvery: 5,
    currentChaseCount: 3,
    currentOutcomes: Object.freeze(["a", "b", "c"]),
  }),
]);

function buildEphemeralObservations(input: {
  controls: MockHeatSimulationControls;
  publicRepackIds: readonly string[];
  baselineStart: number;
  baselineEnd: number;
  currentStart: number;
  currentEnd: number;
}): RepackHeatObservation[] {
  const observations: RepackHeatObservation[] = [];
  const scenarioPhase = Math.floor(
    (input.controls.frameIndex * input.controls.frameStepMilliseconds) /
      MOCK_HEAT_DEFAULT_FRAME_STEP_MILLISECONDS,
  );
  const profileOffset = hashText(input.controls.seed) % scenarioProfiles.length;
  for (const [repackIndex, publicRepackId] of input.publicRepackIds.entries()) {
    const profile = scenarioProfiles[
      (repackIndex + scenarioPhase + profileOffset) %
        scenarioProfiles.length
    ]!;
    const observationSeed = [
      input.controls.seed,
      scenarioPhase,
      publicRepackId,
    ].join(":");
    observations.push(
      ...pulls({
        publicRepackId,
        seed: `${observationSeed}:baseline`,
        count: 480,
        start: input.baselineStart,
        duration: input.baselineEnd - input.baselineStart,
        returnBasisPoints: 10_000,
        hitEvery: 5,
      }),
      {
        kind: "catalog_snapshot",
        publicRepackId,
        occurredAt: iso(input.baselineEnd - 1),
        sequence: input.controls.frameIndex * 2,
        availableChaseCount: 3,
        outcomeKeys: ["a", "b", "c"],
      },
      ...pulls({
        publicRepackId,
        seed: `${observationSeed}:current`,
        count: profile.currentPullCount,
        start: input.currentStart,
        duration: input.currentEnd - input.currentStart,
        returnBasisPoints: profile.returnBasisPoints,
        hitEvery: profile.hitEvery,
      }),
      {
        kind: "catalog_snapshot",
        publicRepackId,
        occurredAt: iso(input.currentEnd - 1),
        sequence: input.controls.frameIndex * 2 + 1,
        availableChaseCount: profile.currentChaseCount,
        outcomeKeys: profile.currentOutcomes,
      },
    );
  }
  return observations;
}

export function mockHeatSnapshotIdFromHash(hash: string): string {
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function mockHeatFrameBody(
  frame: Omit<MockHeatFrame, "contentHash" | "publicHeatSnapshotId">,
) {
  return {
    publicReleaseId: frame.publicReleaseId,
    simulationRunId: frame.simulationRunId,
    sequence: frame.sequence,
    sourceKind: frame.sourceKind,
    scenarioVersion: frame.scenarioVersion,
    aggregationVersion: frame.aggregationVersion,
    heatPolicyVersion: frame.heatPolicyVersion,
    calculatedAt: frame.calculatedAt,
    expiresAt: frame.expiresAt,
    signals: frame.signals,
  };
}

export async function buildMockHeatFrame(
  input: MockHeatSimulationControls,
): Promise<MockHeatFrame> {
  const controls = validateMockHeatControls(input);
  const start = canonicalTimestamp(controls.startAt, "startAt");
  const currentEnd =
    start + controls.frameIndex * controls.publicationCadenceMilliseconds;
  const currentStart = currentEnd - MOCK_HEAT_CURRENT_WINDOW_MILLISECONDS;
  const baselineEnd = currentStart;
  const baselineStart = baselineEnd - MOCK_HEAT_BASELINE_WINDOW_MILLISECONDS;
  const publicRepackIds = buildMockDataReleaseV2().repacks
    .map(({ publicRepackId }) => publicRepackId)
    .sort();
  const simulationRunId = await sha256CanonicalJson(MOCK_HEAT_RUN_HASH_DOMAIN, {
    seed: controls.seed,
    startAt: controls.startAt,
    frameStepMilliseconds: controls.frameStepMilliseconds,
    publicationCadenceMilliseconds: controls.publicationCadenceMilliseconds,
    scenarioVersion: MOCK_HEAT_SCENARIO_VERSION,
  });
  const signals = calculateRepackHeat({
    publicRepackIds,
    observations: buildEphemeralObservations({
      controls,
      publicRepackIds,
      baselineStart,
      baselineEnd,
      currentStart,
      currentEnd,
    }),
    currentWindow: { startAt: iso(currentStart), endAt: iso(currentEnd) },
    baselineWindow: { startAt: iso(baselineStart), endAt: iso(baselineEnd) },
    provenance: {
      kind: "simulated",
      aggregationVersion: REPACK_HEAT_AGGREGATION_VERSION,
      scenarioVersion: MOCK_HEAT_SCENARIO_VERSION,
    },
    heatPolicyVersion: REPACK_HEAT_POLICY_VERSION,
    sourceCoverageComplete: true,
    calculatedAt: iso(currentEnd),
    expiresAt: iso(currentEnd + MOCK_HEAT_EXPIRY_MILLISECONDS),
  });
  const withoutIdentity = {
    publicReleaseId: MOCK_DATA_RELEASE_PUBLIC_ID,
    simulationRunId,
    sequence: controls.frameIndex,
    sourceKind: "simulated" as const,
    scenarioVersion: MOCK_HEAT_SCENARIO_VERSION,
    aggregationVersion: REPACK_HEAT_AGGREGATION_VERSION,
    heatPolicyVersion: REPACK_HEAT_POLICY_VERSION,
    calculatedAt: iso(currentEnd),
    expiresAt: iso(currentEnd + MOCK_HEAT_EXPIRY_MILLISECONDS),
    signals,
  };
  const contentHash = await sha256CanonicalJson(
    MOCK_HEAT_FRAME_HASH_DOMAIN,
    mockHeatFrameBody(withoutIdentity),
  );
  return Object.freeze({
    ...withoutIdentity,
    publicHeatSnapshotId: mockHeatSnapshotIdFromHash(contentHash),
    contentHash,
  });
}
