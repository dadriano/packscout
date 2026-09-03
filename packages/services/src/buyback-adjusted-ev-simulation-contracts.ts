import { createHash } from "node:crypto";
import {
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
  PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3,
  canonicalJson,
  parsePackScoutBuybackEvTimestampMillisV1,
} from "@packscout/contracts";
import {
  DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION,
  type DataReleaseV3ActiveState,
} from "./buyback-adjusted-ev-release-types.ts";

/**
 * Deterministic controls, identity namespace, and local-safety guards for the
 * production-faithful buyback-adjusted EV simulation
 * (task buyback-adjusted-ev/009).
 *
 * Every simulated artifact derives from the explicit controls below — seed,
 * scenario version, start time, frame index, and frame step — through
 * domain-separated sha-256 digests. No module on the simulation path ever
 * consults `Date.now()` or `Math.random()`: identical controls replay
 * byte-equivalent source revisions, evidence, fingerprints, revisions,
 * calculations, confidence, and public release hashes.
 *
 * ## Simulated provenance
 *
 * The data_release_v3 contract deliberately carries no environment or origin
 * field, so simulated releases are labeled through identity, not new public
 * fields:
 *
 * - Every synthetic public entity UUID (repack, vendor, category,
 *   collectible) is minted in the documented simulated namespace: a valid
 *   v5-shaped UUID whose first hex group starts with
 *   {@link PACKSCOUT_BUYBACK_EV_SIMULATED_UUID_PREFIX} (`5eeded`, read
 *   "seeded"). {@link isPackScoutBuybackEvSimulatedPublicIdV1} recognizes it.
 * - Vendor keys, vendor display names, repack names, and descriptions are
 *   existing task-007 fields and carry explicit "Simulated" copy.
 * - The release configuration hash (the release fingerprint) plus the
 *   reported {@link packScoutBuybackEvSimulationRunIdV1 run identity} tie
 *   every published release back to the exact controls that reproduce it.
 */

export const PACKSCOUT_BUYBACK_EV_SIMULATION_SCENARIO_VERSION =
  "packscout-buyback-ev-simulation-scenarios-v1" as const;

/** Documented simulated-identity namespace marker ("seeded"). */
export const PACKSCOUT_BUYBACK_EV_SIMULATED_UUID_PREFIX = "5eeded" as const;

const SIMULATION_DIGEST_DOMAIN = "packscout.buyback-ev-simulation.digest.v1";

export const PACKSCOUT_BUYBACK_EV_SIMULATION_SEED_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
export const PACKSCOUT_BUYBACK_EV_SIMULATION_MAX_FRAME_INDEX = 100_000;
export const PACKSCOUT_BUYBACK_EV_SIMULATION_MIN_FRAME_STEP_MILLISECONDS =
  60_000;
export const PACKSCOUT_BUYBACK_EV_SIMULATION_MAX_FRAME_STEP_MILLISECONDS =
  3_600_000;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export type PackScoutBuybackEvSimulationGuardCodeV1 =
  | "INVALID_CONTROLS"
  | "NON_LOOPBACK_SERVICE_URL"
  | "UNSUPPORTED_PROTOCOL_VERSION"
  | "CANONICAL_RELEASE_TARGET"
  | "FRAME_SEQUENCE_GAP"
  | "MALFORMED_HASH"
  | "SIMULATION_WRITES_DISABLED"
  | "FUTURE_EVENT_TIME";

export class PackScoutBuybackEvSimulationGuardError extends Error {
  constructor(
    readonly code: PackScoutBuybackEvSimulationGuardCodeV1,
    message: string,
  ) {
    super(message);
    this.name = "PackScoutBuybackEvSimulationGuardError";
  }
}

function refuse(
  code: PackScoutBuybackEvSimulationGuardCodeV1,
  message: string,
): never {
  throw new PackScoutBuybackEvSimulationGuardError(code, message);
}

/** The explicit deterministic controls every simulated frame derives from. */
export interface PackScoutBuybackEvSimulationControlsV1 {
  readonly seed: string;
  readonly scenarioVersion:
    typeof PACKSCOUT_BUYBACK_EV_SIMULATION_SCENARIO_VERSION;
  /** Canonical UTC millisecond timestamp anchoring frame 0. */
  readonly startAt: string;
  /** Virtual calculation-clock advance between successive frames. */
  readonly frameStepMilliseconds: number;
}

/** Validates and freezes one control set; anything else is refused. */
export function validatePackScoutBuybackEvSimulationControlsV1(
  controls: PackScoutBuybackEvSimulationControlsV1,
): PackScoutBuybackEvSimulationControlsV1 {
  if (!PACKSCOUT_BUYBACK_EV_SIMULATION_SEED_PATTERN.test(controls.seed)) {
    refuse("INVALID_CONTROLS", "The simulation seed is invalid.");
  }
  if (
    controls.scenarioVersion !== PACKSCOUT_BUYBACK_EV_SIMULATION_SCENARIO_VERSION
  ) {
    refuse(
      "UNSUPPORTED_PROTOCOL_VERSION",
      "The simulation scenario version is unsupported.",
    );
  }
  const startAtMillis = parsePackScoutBuybackEvTimestampMillisV1(
    controls.startAt,
  );
  if (startAtMillis === null) {
    refuse(
      "INVALID_CONTROLS",
      "The simulation start time must be a canonical UTC millisecond timestamp.",
    );
  }
  if (
    !Number.isSafeInteger(controls.frameStepMilliseconds) ||
    controls.frameStepMilliseconds <
      PACKSCOUT_BUYBACK_EV_SIMULATION_MIN_FRAME_STEP_MILLISECONDS ||
    controls.frameStepMilliseconds >
      PACKSCOUT_BUYBACK_EV_SIMULATION_MAX_FRAME_STEP_MILLISECONDS
  ) {
    refuse("INVALID_CONTROLS", "The simulation frame step is out of bounds.");
  }
  return Object.freeze({ ...controls });
}

export function assertPackScoutBuybackEvSimulationFrameIndexV1(
  frameIndex: number,
): void {
  if (
    !Number.isSafeInteger(frameIndex) ||
    frameIndex < 0 ||
    frameIndex > PACKSCOUT_BUYBACK_EV_SIMULATION_MAX_FRAME_INDEX
  ) {
    refuse("INVALID_CONTROLS", "The simulation frame index is out of bounds.");
  }
}

/** Domain-separated sha-256 over canonical JSON; the only randomness source. */
export function packScoutBuybackEvSimulationDigestV1(
  scope: string,
  value: unknown,
): string {
  return createHash("sha256")
    .update(canonicalJson({ hashDomain: SIMULATION_DIGEST_DOMAIN, scope, value }))
    .digest("hex");
}

/**
 * Mints a deterministic v5-shaped UUID inside the documented simulated
 * namespace: `5eeded` + digest bytes, version nibble 5, variant nibble 8.
 */
export function packScoutBuybackEvSimulatedUuidV1(
  scope: string,
  value: unknown,
): string {
  const hex = packScoutBuybackEvSimulationDigestV1(`uuid:${scope}`, value);
  return (
    `${PACKSCOUT_BUYBACK_EV_SIMULATED_UUID_PREFIX}${hex.slice(0, 2)}` +
    `-${hex.slice(2, 6)}-5${hex.slice(7, 10)}-8${hex.slice(11, 14)}-${hex.slice(14, 26)}`
  );
}

/** Whether a public id belongs to the documented simulated namespace. */
export function isPackScoutBuybackEvSimulatedPublicIdV1(value: string): boolean {
  return (
    UUID_PATTERN.test(value) &&
    value.startsWith(PACKSCOUT_BUYBACK_EV_SIMULATED_UUID_PREFIX)
  );
}

/** One run identity: the digest of the exact reproducing controls. */
export function packScoutBuybackEvSimulationRunIdV1(
  controls: PackScoutBuybackEvSimulationControlsV1,
): string {
  return packScoutBuybackEvSimulationDigestV1("run", {
    seed: controls.seed,
    scenarioVersion: controls.scenarioVersion,
    startAt: controls.startAt,
    frameStepMilliseconds: controls.frameStepMilliseconds,
  });
}

/** The virtual calculation clock of one frame. */
export function packScoutBuybackEvSimulationFrameClockV1(
  controls: PackScoutBuybackEvSimulationControlsV1,
  frameIndex: number,
): string {
  assertPackScoutBuybackEvSimulationFrameIndexV1(frameIndex);
  const startAtMillis = parsePackScoutBuybackEvTimestampMillisV1(
    controls.startAt,
  );
  if (startAtMillis === null) {
    refuse("INVALID_CONTROLS", "The simulation start time is not canonical.");
  }
  return new Date(
    startAtMillis + frameIndex * controls.frameStepMilliseconds,
  ).toISOString();
}

/**
 * Accepts only a root HTTP loopback origin for local simulation writes.
 * Cloud URLs, HTTPS deployments, credentials, paths, and query strings are
 * refused before any write can be attempted.
 */
export function assertPackScoutBuybackEvSimulationLoopbackUrlV1(
  url: string,
): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    refuse("NON_LOOPBACK_SERVICE_URL", "The simulation service URL is invalid.");
  }
  if (
    parsed.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(parsed.hostname) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    refuse(
      "NON_LOOPBACK_SERVICE_URL",
      "The simulation accepts only a root HTTP loopback service URL.",
    );
  }
  return parsed.origin;
}

export interface PackScoutBuybackEvSimulationProtocolVersionsV1 {
  readonly publicationSchemaVersion: string;
  readonly methodVersion: string;
  readonly confidencePolicyVersion: string;
  readonly publicEvPolicyVersion: string;
  readonly scenarioVersion: string;
}

/** Exact supported protocol versions; anything else fails closed. */
export function assertPackScoutBuybackEvSimulationProtocolVersionsV1(
  versions: PackScoutBuybackEvSimulationProtocolVersionsV1,
): void {
  if (
    versions.publicationSchemaVersion !==
      DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION ||
    versions.methodVersion !== PACKSCOUT_BUYBACK_EV_METHOD_VERSION ||
    versions.confidencePolicyVersion !==
      PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION ||
    versions.publicEvPolicyVersion !== PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3 ||
    versions.scenarioVersion !==
      PACKSCOUT_BUYBACK_EV_SIMULATION_SCENARIO_VERSION
  ) {
    refuse(
      "UNSUPPORTED_PROTOCOL_VERSION",
      "The simulation supports exactly one publication, method, confidence, and scenario version set.",
    );
  }
}

/**
 * A simulated release may activate only over genesis or a release this
 * simulation lineage produced (or that the operator explicitly named).
 * Anything else is treated as a canonical release target and refused.
 */
export function assertPackScoutBuybackEvSimulationActiveReleaseV1(
  state: DataReleaseV3ActiveState,
  allowedActiveReleaseIds: ReadonlySet<string>,
): void {
  const active = state.activeRelease;
  if (active === null) return;
  if (
    active.methodVersion !== PACKSCOUT_BUYBACK_EV_METHOD_VERSION ||
    active.confidencePolicyVersion !==
      PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION ||
    active.publicEvPolicyVersion !== PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3
  ) {
    refuse(
      "UNSUPPORTED_PROTOCOL_VERSION",
      "The active release carries an unsupported calculation version.",
    );
  }
  if (!allowedActiveReleaseIds.has(active.publicReleaseId)) {
    refuse(
      "CANONICAL_RELEASE_TARGET",
      "Refusing to publish over an active release this simulation does not own.",
    );
  }
}

/** Frames replay in order; a sequence gap is a refused replay conflict. */
export function assertPackScoutBuybackEvSimulationFrameSequenceV1(
  previousFrameIndex: number | null,
  nextFrameIndex: number,
): void {
  assertPackScoutBuybackEvSimulationFrameIndexV1(nextFrameIndex);
  if (
    previousFrameIndex !== null &&
    nextFrameIndex !== previousFrameIndex + 1
  ) {
    refuse(
      "FRAME_SEQUENCE_GAP",
      "Simulation frames must advance by exactly one; gaps and rewinds are refused.",
    );
  }
}

export function assertPackScoutBuybackEvSimulationSha256V1(
  value: string,
  label: string,
): void {
  if (!SHA256_PATTERN.test(value)) {
    refuse("MALFORMED_HASH", `${label} must be a lowercase sha-256 hex digest.`);
  }
}

export function assertPackScoutBuybackEvSimulationReleaseIdV1(
  value: string,
  label: string,
): void {
  if (!UUID_PATTERN.test(value)) {
    refuse("MALFORMED_HASH", `${label} must be a canonical UUID.`);
  }
}

/** Refuses a frame whose virtual clock would sit in the observer's future. */
export function assertPackScoutBuybackEvSimulationEventTimeV1(
  frameClock: string,
  wallClock: string,
): void {
  const frameMillis = parsePackScoutBuybackEvTimestampMillisV1(frameClock);
  const wallMillis = Date.parse(wallClock);
  if (frameMillis === null || !Number.isFinite(wallMillis)) {
    refuse("INVALID_CONTROLS", "Simulation clocks must be canonical timestamps.");
  }
  if (frameMillis > wallMillis) {
    refuse(
      "FUTURE_EVENT_TIME",
      "Simulation frames never move event time into the observer's future; advance the calculation clock inside a past window instead.",
    );
  }
}

export interface PackScoutBuybackEvSimulationWriteEnablementV1 {
  readonly loopbackOrigin: string;
  readonly protocolVersions: PackScoutBuybackEvSimulationProtocolVersionsV1;
  readonly activeState: DataReleaseV3ActiveState;
  readonly allowedActiveReleaseIds: readonly string[];
}

/**
 * Explicit local-only write gate. Publication writes are refused until every
 * precondition — loopback origin, exact protocol versions, and a genesis or
 * simulation-owned active release — is proven in one `enable` call, and are
 * refused again the moment `disable` runs (cleanup on success, failure, and
 * interruption all call it).
 */
export class PackScoutBuybackEvSimulationWriteGateV1 {
  #enabled = false;

  get enabled(): boolean {
    return this.#enabled;
  }

  enable(enablement: PackScoutBuybackEvSimulationWriteEnablementV1): void {
    assertPackScoutBuybackEvSimulationLoopbackUrlV1(enablement.loopbackOrigin);
    assertPackScoutBuybackEvSimulationProtocolVersionsV1(
      enablement.protocolVersions,
    );
    for (const releaseId of enablement.allowedActiveReleaseIds) {
      assertPackScoutBuybackEvSimulationReleaseIdV1(
        releaseId,
        "An allowed active release id",
      );
    }
    assertPackScoutBuybackEvSimulationActiveReleaseV1(
      enablement.activeState,
      new Set(enablement.allowedActiveReleaseIds),
    );
    this.#enabled = true;
  }

  assertEnabled(): void {
    if (!this.#enabled) {
      refuse(
        "SIMULATION_WRITES_DISABLED",
        "Simulation writes are disabled; explicit local-only enablement is required.",
      );
    }
  }

  disable(): void {
    this.#enabled = false;
  }
}
