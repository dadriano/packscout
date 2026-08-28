import {
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
  PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3,
  parsePackScoutBuybackEvTimestampMillisV1,
  safeParsePublicRepackDetailV3,
  type PackScoutBuybackEvPublicReasonCodeV1,
  type PublicRepackDetailV3,
} from "@packscout/contracts";
import type { PackScoutBuybackEvRecomputationCommandV1 } from "./buyback-adjusted-ev-recomputation-contracts.ts";
import {
  BuybackAdjustedEvRecomputationProcessor,
  type BuybackAdjustedEvRecomputationClaim,
  type BuybackAdjustedEvRecomputationQueue,
} from "./buyback-adjusted-ev-recomputation-processor.ts";
import { PackScoutBuybackAdjustedEvRecomputationService } from "./buyback-adjusted-ev-recomputation-service.ts";
import type { PackScoutBuybackEvRevisionRecordV1 } from "./buyback-adjusted-ev-revision-contracts.ts";
import type { OperationalObservability } from "./operational-events.ts";
import {
  PackScoutBuybackEvRevisionStore,
  type PackScoutBuybackEvRevisionPersistencePortV1,
  type PersistBuybackEvRevisionPortInput,
} from "./buyback-adjusted-ev-revision-store.ts";
import { DataReleaseV3ReleaseAssembler } from "./buyback-adjusted-ev-release-assembler.ts";
import { DataReleaseV3ReleasePublisher } from "./buyback-adjusted-ev-release-publisher.ts";
import {
  DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION,
  type DataReleaseV3CanonicalCatalogPort,
  type DataReleaseV3PublicationPort,
  type DataReleaseV3PublishPlan,
} from "./buyback-adjusted-ev-release-types.ts";
import {
  PackScoutBuybackEvSimulationWriteGateV1,
  assertPackScoutBuybackEvSimulationActiveReleaseV1,
  assertPackScoutBuybackEvSimulationEventTimeV1,
  assertPackScoutBuybackEvSimulationFrameSequenceV1,
  assertPackScoutBuybackEvSimulationLoopbackUrlV1,
  assertPackScoutBuybackEvSimulationReleaseIdV1,
  packScoutBuybackEvSimulatedUuidV1,
  packScoutBuybackEvSimulationDigestV1,
  packScoutBuybackEvSimulationRunIdV1,
  validatePackScoutBuybackEvSimulationControlsV1,
  type PackScoutBuybackEvSimulationControlsV1,
} from "./buyback-adjusted-ev-simulation-contracts.ts";
import { PACKSCOUT_BUYBACK_EV_SIMULATION_SCENARIO_VERSION } from "./buyback-adjusted-ev-simulation-contracts.ts";
import {
  buildPackScoutBuybackEvSimulationFrameV1,
  type PackScoutBuybackEvSimulationFrameV1,
  type PackScoutBuybackEvSimulationScenarioKeyV1,
} from "./buyback-adjusted-ev-simulation-scenarios.ts";

/**
 * Production-faithful local simulation runner (task buyback-adjusted-ev/009).
 *
 * One frame flows through the complete post-ingestion production path with no
 * simulation-only business branch: the real provider normalization already
 * ran inside the frame builder (task 004), the real recomputation processor
 * and service resolve every work item through the task-002 calculator, the
 * task-003 confidence policy, and the task-005 immutable revision store
 * (backed here by the local ephemeral in-memory persistence adapter), the
 * real task-008 assembler and publisher stage and atomically activate the
 * release through the injected `DataReleaseV3PublicationPort`, and the
 * task-007 public projection is read back from the activated plan and
 * re-proven against the public contracts.
 *
 * Persistence rules: synthetic raw source revisions live only inside the
 * frame value; the only stored artifacts are the canonical protected
 * revisions written through the task-005 store and the sanitized aggregate
 * release accepted by the publication port.
 */

export type PackScoutBuybackEvSimulationRunErrorCodeV1 =
  | "RECOMPUTATION_FAILED"
  | "PLAN_BLOCKED"
  | "EXPECTATION_MISMATCH"
  | "READ_BACK_DIVERGENT";

export class PackScoutBuybackEvSimulationRunError extends Error {
  constructor(
    readonly code: PackScoutBuybackEvSimulationRunErrorCodeV1,
    message: string,
    readonly scenarioKey: string | null = null,
  ) {
    super(message);
    this.name = "PackScoutBuybackEvSimulationRunError";
  }
}

function runFailure(
  code: PackScoutBuybackEvSimulationRunErrorCodeV1,
  message: string,
  scenarioKey: string | null = null,
): never {
  throw new PackScoutBuybackEvSimulationRunError(code, message, scenarioKey);
}

/**
 * Local ephemeral persistence adapter behind the real task-005 revision
 * store: identical replay, identity-conflict, result-conflict, failure-ledger
 * dedupe, the in-transaction essential-source ordering guard, and
 * completed-current selection semantics, with deterministic revision
 * identities minted in the simulated namespace.
 */
export class PackScoutBuybackEvSimulationRevisionMemoryPortV1
implements PackScoutBuybackEvRevisionPersistencePortV1 {
  readonly rows: PackScoutBuybackEvRevisionRecordV1[] = [];
  readonly failures = new Map<
    string,
    { reasonCode: string; occurrenceCount: number }
  >();
  #sequence = 0;

  async persistCompletedRevision(input: PersistBuybackEvRevisionPortInput) {
    const existing = this.rows.find(
      (row) =>
        row.organizationId === input.organizationId &&
        row.calculationKey === input.calculationKey,
    );
    if (existing) {
      if (existing.effectiveFingerprint !== input.effectiveFingerprint) {
        return { outcome: "identity_conflict" as const };
      }
      if (existing.resultHash !== input.resultHash) {
        return { outcome: "result_conflict" as const };
      }
      return { outcome: "unchanged" as const, row: existing };
    }
    const fingerprintOwned = this.rows.some(
      (row) =>
        row.organizationId === input.organizationId &&
        row.effectiveFingerprint === input.effectiveFingerprint,
    );
    if (fingerprintOwned) {
      return { outcome: "identity_conflict" as const };
    }
    const productRows = this.rows
      .filter(
        (row) =>
          row.organizationId === input.organizationId &&
          row.platformKey === input.platformKey &&
          row.productKey === input.productKey,
      )
      .sort((left, right) => right.revisionNumber - left.revisionNumber);
    const currentRow = productRows[0] ?? null;
    // Mirror of the repository's in-transaction ordering guard: strictly
    // older (or unprovable) essential source evidence never becomes current.
    if (currentRow !== null && currentRow.dataAsOf.observedAt !== null) {
      const incomingObservedAtMilliseconds =
        input.dataAsOf.state === "known"
          ? Date.parse(input.dataAsOf.observedAt)
          : null;
      if (
        incomingObservedAtMilliseconds === null ||
        incomingObservedAtMilliseconds <
          Date.parse(currentRow.dataAsOf.observedAt)
      ) {
        return { outcome: "superseded" as const, row: currentRow };
      }
    }
    const revisionNumber = (currentRow?.revisionNumber ?? 0) + 1;
    this.#sequence += 1;
    const row: PackScoutBuybackEvRevisionRecordV1 = {
      revisionId: packScoutBuybackEvSimulatedUuidV1("revision", {
        sequence: this.#sequence,
      }),
      organizationId: input.organizationId,
      providerId: input.providerId,
      providerSourceRevisionId: input.providerSourceRevisionId,
      sourceInstanceId: packScoutBuybackEvSimulatedUuidV1("source-instance", {
        providerSourceRevisionId: input.providerSourceRevisionId,
      }),
      platformKey: input.platformKey,
      productKey: input.productKey,
      productRevisionId: input.productRevisionId,
      methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
      confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
      lifecycle: "completed",
      status: input.status,
      revisionNumber,
      calculationKey: input.calculationKey,
      effectiveFingerprint: input.effectiveFingerprint,
      resultHash: input.resultHash,
      sourceRevisionId: input.sourceRevisionId,
      sourceManifestSha256: input.sourceManifestSha256,
      observationCoherence: input.observationCoherence,
      oddsSource: input.oddsSource,
      usedClosedRangeMidpoint: input.usedClosedRangeMidpoint,
      calculatedAt: input.calculatedAt,
      dataAsOf: input.dataAsOf,
      metrics: input.metrics,
      confidence: input.confidence,
      freshness: input.freshness,
      internalReasons: input.internalReasons,
      publicPrimaryReason: input.publicPrimaryReason,
      createdAt: input.calculatedAt,
    };
    this.rows.push(row);
    return { outcome: "created" as const, row };
  }

  async recordPersistenceFailure(input: {
    readonly organizationId: string;
    readonly failureKey: string;
    readonly reasonCode:
      | "CONTRACT_VIOLATION"
      | "IDENTITY_REUSE_CONFLICT"
      | "RESULT_CONFLICT"
      | "UNBINDABLE_RESULT";
    readonly providerId: string | null;
    readonly platformKey: string | null;
    readonly productKey: string | null;
    readonly seenAt: string;
  }) {
    const existing = this.failures.get(input.failureKey);
    if (existing) {
      existing.occurrenceCount += 1;
      return { occurrenceCount: existing.occurrenceCount, created: false };
    }
    this.failures.set(input.failureKey, {
      reasonCode: input.reasonCode,
      occurrenceCount: 1,
    });
    return { occurrenceCount: 1, created: true };
  }

  async getCurrentCompletedRevision(input: {
    readonly organizationId: string;
    readonly platformKey: string;
    readonly productKey: string;
    readonly methodVersion: string;
  }) {
    const candidates = this.rows
      .filter(
        (row) =>
          row.organizationId === input.organizationId &&
          row.platformKey === input.platformKey &&
          row.productKey === input.productKey &&
          row.lifecycle === "completed" &&
          row.methodVersion === input.methodVersion,
      )
      .sort((left, right) => right.revisionNumber - left.revisionNumber);
    return candidates[0] ?? null;
  }

  async getRevisionTrace() {
    return null;
  }
}

interface SimulationQueueRecord {
  readonly id: string;
  readonly command: PackScoutBuybackEvRecomputationCommandV1;
  readonly scheduledAt: string;
  state: "queued" | "claimed" | "completed" | "failed";
  attemptCount: number;
  claimToken: string | null;
  resultStatus: string | null;
  revisionId: string | null;
  outcomeReasonCode: string | null;
  failureCode: string | null;
}

/** Deterministic in-memory work queue; claim tokens derive from request ids. */
class DeterministicSimulationQueue
implements BuybackAdjustedEvRecomputationQueue {
  readonly records: SimulationQueueRecord[] = [];

  enqueue(
    id: string,
    command: PackScoutBuybackEvRecomputationCommandV1,
    scheduledAt: string,
  ): void {
    this.records.push({
      id,
      command,
      scheduledAt,
      state: "queued",
      attemptCount: 0,
      claimToken: null,
      resultStatus: null,
      revisionId: null,
      outcomeReasonCode: null,
      failureCode: null,
    });
  }

  async claimBatch(input: {
    workerId: string;
    now: Date;
    limit: number;
    leaseMilliseconds: number;
  }): Promise<readonly BuybackAdjustedEvRecomputationClaim[]> {
    const claims: BuybackAdjustedEvRecomputationClaim[] = [];
    for (const record of this.records) {
      if (claims.length >= input.limit) break;
      if (record.state !== "queued") continue;
      record.state = "claimed";
      record.attemptCount += 1;
      record.claimToken = `claim-${record.id}-${record.attemptCount}`;
      claims.push({
        id: record.id,
        claimToken: record.claimToken,
        attemptCount: record.attemptCount,
        scheduledAt: record.scheduledAt,
        command: record.command,
      });
    }
    return claims;
  }

  async complete(input: {
    requestId: string;
    claimToken: string;
    completedAt: Date;
    resultStatus: string;
    revisionId: string | null;
    outcomeReasonCode?: string;
  }): Promise<boolean> {
    const record = this.records.find(({ id }) => id === input.requestId);
    if (
      !record ||
      record.state !== "claimed" ||
      record.claimToken !== input.claimToken
    ) {
      return false;
    }
    record.state = "completed";
    record.resultStatus = input.resultStatus;
    record.revisionId = input.revisionId;
    record.outcomeReasonCode = input.outcomeReasonCode ?? null;
    return true;
  }

  async recordFailure(input: {
    requestId: string;
    claimToken: string;
    failedAt: Date;
    retryAt: Date;
    failureCode: string;
    maximumAttempts: number;
  }): Promise<"failed" | "lost" | "retrying"> {
    const record = this.records.find(({ id }) => id === input.requestId);
    if (
      !record ||
      record.state !== "claimed" ||
      record.claimToken !== input.claimToken
    ) {
      return "lost";
    }
    record.failureCode = input.failureCode;
    record.state = "failed";
    return "failed";
  }
}

export interface PackScoutBuybackEvSimulationScenarioResultV1 {
  readonly scenarioKey: PackScoutBuybackEvSimulationScenarioKeyV1;
  readonly providerKey: string;
  readonly recomputationOutcome: "created" | "unchanged";
  readonly revisionId: string;
  readonly publicRepackId: string;
  readonly publicState: "current" | "sold_out_historical" | "unavailable";
  readonly publicReason: PackScoutBuybackEvPublicReasonCodeV1 | null;
}

export interface PackScoutBuybackEvSimulationFrameResultV1 {
  readonly scenarioVersion:
    typeof PACKSCOUT_BUYBACK_EV_SIMULATION_SCENARIO_VERSION;
  readonly simulationRunId: string;
  readonly frameIndex: number;
  readonly readAt: string;
  readonly publishOutcome: "activated" | "unchanged";
  readonly publicReleaseId: string;
  readonly releaseFingerprint: string;
  readonly previousPublicReleaseId: string | null;
  readonly scenarioResults:
    readonly PackScoutBuybackEvSimulationScenarioResultV1[];
  readonly publicDetails: readonly PublicRepackDetailV3[];
  /** Digest of the sanitized public repack details for replay comparison. */
  readonly frameContentDigest: string;
}

export interface PackScoutBuybackEvSimulatorOptionsV1 {
  readonly port: DataReleaseV3PublicationPort;
  readonly controls: PackScoutBuybackEvSimulationControlsV1;
  readonly gate: PackScoutBuybackEvSimulationWriteGateV1;
  /** Release ids the simulation may replace beyond the ones it published. */
  readonly allowedActiveReleaseIds?: readonly string[];
  /** When provided, frames whose clock is in this observer's future refuse. */
  readonly wallClock?: () => Date;
  /** Bounded operational reporting only; raw sources never reach it. */
  readonly operational?: OperationalObservability;
}

export class PackScoutBuybackEvSimulator {
  readonly #controls: PackScoutBuybackEvSimulationControlsV1;
  readonly #port: DataReleaseV3PublicationPort;
  readonly #gate: PackScoutBuybackEvSimulationWriteGateV1;
  readonly #wallClock: (() => Date) | null;
  readonly #memory = new PackScoutBuybackEvSimulationRevisionMemoryPortV1();
  readonly #service: PackScoutBuybackAdjustedEvRecomputationService;
  readonly #publisher: DataReleaseV3ReleasePublisher;
  readonly #ownReleaseIds = new Set<string>();
  readonly #allowedActiveReleaseIds: ReadonlySet<string>;
  #lastFrameIndex: number | null = null;

  constructor(options: PackScoutBuybackEvSimulatorOptionsV1) {
    this.#controls = validatePackScoutBuybackEvSimulationControlsV1(
      options.controls,
    );
    this.#port = options.port;
    this.#gate = options.gate;
    this.#wallClock = options.wallClock ?? null;
    for (const releaseId of options.allowedActiveReleaseIds ?? []) {
      assertPackScoutBuybackEvSimulationReleaseIdV1(
        releaseId,
        "An allowed active release id",
      );
    }
    this.#allowedActiveReleaseIds = new Set(
      options.allowedActiveReleaseIds ?? [],
    );
    this.#service = new PackScoutBuybackAdjustedEvRecomputationService(
      new PackScoutBuybackEvRevisionStore(this.#memory, options.operational),
      options.operational,
    );
    this.#publisher = new DataReleaseV3ReleasePublisher(this.#port);
  }

  get simulationRunId(): string {
    return packScoutBuybackEvSimulationRunIdV1(this.#controls);
  }

  /** Canonical protected revisions persisted so far (never raw sources). */
  inspectCanonicalRevisionRows(): readonly PackScoutBuybackEvRevisionRecordV1[] {
    return [...this.#memory.rows];
  }

  /**
   * Drives one frame through recomputation, assembly, publication, and the
   * public read-back. Frames advance by exactly one; re-running the previous
   * frame is a convergent replay.
   */
  async runFrame(
    frameIndex: number,
  ): Promise<PackScoutBuybackEvSimulationFrameResultV1> {
    if (this.#lastFrameIndex === null || frameIndex !== this.#lastFrameIndex) {
      assertPackScoutBuybackEvSimulationFrameSequenceV1(
        this.#lastFrameIndex,
        frameIndex,
      );
    }
    this.#gate.assertEnabled();
    const frame = buildPackScoutBuybackEvSimulationFrameV1(
      this.#controls,
      frameIndex,
    );
    if (this.#wallClock !== null) {
      assertPackScoutBuybackEvSimulationEventTimeV1(
        frame.readAt,
        this.#wallClock().toISOString(),
      );
    }
    this.#assertNoFutureObservation(frame);

    const queueOutcomes = await this.#recompute(frame);
    const plan = await this.#assemble(frame);
    this.#gate.assertEnabled();
    const state = await this.#port.activeState();
    const allowed = new Set([
      ...this.#ownReleaseIds,
      ...this.#allowedActiveReleaseIds,
      plan.publicReleaseId,
    ]);
    // Refuse before staging when the active pointer is not simulation-owned.
    assertPackScoutBuybackEvSimulationActiveReleaseV1(state, allowed);

    const outcome = await this.#publisher.publish(plan);
    const status = await this.#port.status(plan.publicReleaseId);
    if (
      status === null ||
      status.lifecycle !== "complete" ||
      status.releaseFingerprint !== plan.releaseFingerprint
    ) {
      runFailure(
        "READ_BACK_DIVERGENT",
        "The activated simulated release did not read back complete.",
      );
    }
    const publicDetails = plan.batches
      .filter((batch) => batch.kind === "repacks")
      .flatMap((batch) => batch.records as readonly PublicRepackDetailV3[]);
    const scenarioResults = this.#verify(frame, queueOutcomes, publicDetails);

    this.#ownReleaseIds.add(plan.publicReleaseId);
    this.#lastFrameIndex = frameIndex;
    return {
      scenarioVersion: PACKSCOUT_BUYBACK_EV_SIMULATION_SCENARIO_VERSION,
      simulationRunId: frame.simulationRunId,
      frameIndex,
      readAt: frame.readAt,
      publishOutcome: outcome.outcome,
      publicReleaseId: plan.publicReleaseId,
      releaseFingerprint: plan.releaseFingerprint,
      previousPublicReleaseId:
        outcome.outcome === "activated"
          ? outcome.previousPublicReleaseId
          : null,
      scenarioResults,
      publicDetails,
      frameContentDigest: packScoutBuybackEvSimulationDigestV1(
        "frame-content",
        { readAt: frame.readAt, publicDetails },
      ),
    };
  }

  /** Event time never runs ahead of the frame's calculation clock. */
  #assertNoFutureObservation(frame: PackScoutBuybackEvSimulationFrameV1): void {
    const readAtMillis = parsePackScoutBuybackEvTimestampMillisV1(frame.readAt);
    for (const scenario of frame.scenarios) {
      const calculatedAtMillis = parsePackScoutBuybackEvTimestampMillisV1(
        scenario.command.calculatedAt,
      );
      const evidence = scenario.evidence;
      const observedAt =
        evidence.status === "complete"
          ? evidence.input.observation.observedAt
          : evidence.observation?.observedAt ?? null;
      const observedAtMillis =
        observedAt === null
          ? null
          : parsePackScoutBuybackEvTimestampMillisV1(observedAt);
      if (
        readAtMillis === null ||
        calculatedAtMillis === null ||
        calculatedAtMillis > readAtMillis ||
        (observedAtMillis !== null && observedAtMillis > calculatedAtMillis)
      ) {
        runFailure(
          "EXPECTATION_MISMATCH",
          "A simulated observation may never sit in the future of its calculation clock.",
          scenario.scenarioKey,
        );
      }
    }
  }

  async #recompute(
    frame: PackScoutBuybackEvSimulationFrameV1,
  ): Promise<ReadonlyMap<string, SimulationQueueRecord>> {
    const queue = new DeterministicSimulationQueue();
    for (const scenario of frame.scenarios) {
      queue.enqueue(
        `frame-${frame.frameIndex}:${scenario.scenarioKey}`,
        scenario.command,
        frame.readAt,
      );
    }
    const processor = new BuybackAdjustedEvRecomputationProcessor(
      queue,
      this.#service,
      { now: () => new Date(frame.readAt) },
      { workerId: "packscout-buyback-ev-simulator" },
    );
    // Bounded: every cycle claims pending work exactly once.
    let cycles = 0;
    for (;;) {
      const cycle = await processor.runCycle();
      cycles += 1;
      if (cycle.claimed === 0) break;
      if (cycles > frame.scenarios.length + 1) {
        runFailure(
          "RECOMPUTATION_FAILED",
          "The simulation work queue did not drain deterministically.",
        );
      }
    }
    const byScenario = new Map<string, SimulationQueueRecord>();
    for (const record of queue.records) {
      const scenarioKey = record.id.slice(record.id.indexOf(":") + 1);
      if (
        record.state !== "completed" ||
        (record.resultStatus !== "created" &&
          record.resultStatus !== "unchanged") ||
        record.revisionId === null
      ) {
        runFailure(
          "RECOMPUTATION_FAILED",
          `Simulated recomputation resolved to ${record.failureCode ?? record.resultStatus ?? record.state}.`,
          scenarioKey,
        );
      }
      byScenario.set(scenarioKey, record);
    }
    return byScenario;
  }

  async #assemble(
    frame: PackScoutBuybackEvSimulationFrameV1,
  ): Promise<DataReleaseV3PublishPlan> {
    const catalog: DataReleaseV3CanonicalCatalogPort = {
      loadCatalogSnapshot: async ({ readAt }) => {
        if (readAt !== frame.readAt) {
          runFailure(
            "READ_BACK_DIVERGENT",
            "The release read clock diverged from the frame clock.",
          );
        }
        return frame.snapshot;
      },
    };
    const assembler = new DataReleaseV3ReleaseAssembler(catalog, this.#service);
    const plan = await assembler.assemble({ readAt: frame.readAt });
    if (plan.classification === "blocked") {
      runFailure(
        "PLAN_BLOCKED",
        `The release assembler blocked the simulated frame: ${plan.reason}.`,
        plan.blockedProductKey,
      );
    }
    return plan;
  }

  #verify(
    frame: PackScoutBuybackEvSimulationFrameV1,
    queueOutcomes: ReadonlyMap<string, SimulationQueueRecord>,
    publicDetails: readonly PublicRepackDetailV3[],
  ): readonly PackScoutBuybackEvSimulationScenarioResultV1[] {
    const detailByRepackId = new Map(
      publicDetails.map((detail) => [detail.publicRepackId, detail]),
    );
    return frame.scenarios.map((scenario) => {
      const record = queueOutcomes.get(scenario.scenarioKey);
      const detail = detailByRepackId.get(scenario.product.publicRepackId);
      if (record === undefined || detail === undefined) {
        runFailure(
          "READ_BACK_DIVERGENT",
          "A simulated scenario is missing from the published release.",
          scenario.scenarioKey,
        );
      }
      const parsed = safeParsePublicRepackDetailV3(detail, frame.readAt);
      if (!parsed.success) {
        runFailure(
          "READ_BACK_DIVERGENT",
          `The published simulated detail failed the public contract: ${parsed.reason}.`,
          scenario.scenarioKey,
        );
      }
      const packScout = detail.evEstimates.packScout;
      const expectation = scenario.expectation;
      const limitationCodes =
        packScout.status === "unavailable"
          ? []
          : packScout.confidence.limitationCodes;
      const expectationHolds =
        packScout.status === expectation.publicState &&
        (packScout.status !== "unavailable" ||
          packScout.reason === expectation.publicReason) &&
        JSON.stringify(limitationCodes) ===
          JSON.stringify(expectation.limitationCodes);
      if (!expectationHolds) {
        runFailure(
          "EXPECTATION_MISMATCH",
          `Scenario ${scenario.scenarioKey} resolved to ${packScout.status} instead of ${expectation.publicState}.`,
          scenario.scenarioKey,
        );
      }
      return {
        scenarioKey: scenario.scenarioKey,
        providerKey: scenario.providerKey,
        recomputationOutcome:
          record.resultStatus === "created" ? "created" : "unchanged",
        revisionId: record.revisionId!,
        publicRepackId: scenario.product.publicRepackId,
        publicState: packScout.status,
        publicReason:
          packScout.status === "unavailable" ? packScout.reason : null,
      };
    });
  }
}

export interface PackScoutBuybackEvSimulationSessionV1 {
  readonly simulator: PackScoutBuybackEvSimulator;
  readonly simulationRunId: string;
  /** Disables further simulation writes; always runs during cleanup. */
  close(): void;
}

/**
 * Opens one local simulation session: proves the loopback origin, exact
 * protocol versions, and a genesis or simulation-owned active release, then
 * enables the write gate. `close` disables writes again and must run on
 * success, failure, and interruption.
 */
export async function openPackScoutBuybackEvSimulationSessionV1(options: {
  readonly port: DataReleaseV3PublicationPort;
  readonly controls: PackScoutBuybackEvSimulationControlsV1;
  readonly publicationOrigin: string;
  readonly allowedActiveReleaseIds?: readonly string[];
  readonly wallClock?: () => Date;
  readonly operational?: OperationalObservability;
}): Promise<PackScoutBuybackEvSimulationSessionV1> {
  const controls = validatePackScoutBuybackEvSimulationControlsV1(
    options.controls,
  );
  const loopbackOrigin = assertPackScoutBuybackEvSimulationLoopbackUrlV1(
    options.publicationOrigin,
  );
  const gate = new PackScoutBuybackEvSimulationWriteGateV1();
  const activeState = await options.port.activeState();
  gate.enable({
    loopbackOrigin,
    protocolVersions: {
      publicationSchemaVersion: DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION,
      methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
      confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
      publicEvPolicyVersion: PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3,
      scenarioVersion: controls.scenarioVersion,
    },
    activeState,
    allowedActiveReleaseIds: options.allowedActiveReleaseIds ?? [],
  });
  const simulator = new PackScoutBuybackEvSimulator({
    port: options.port,
    controls,
    gate,
    allowedActiveReleaseIds: options.allowedActiveReleaseIds ?? [],
    wallClock: options.wallClock,
    operational: options.operational,
  });
  return {
    simulator,
    simulationRunId: simulator.simulationRunId,
    close: () => gate.disable(),
  };
}
