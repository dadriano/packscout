import {
  DataReleaseV3ReleasePublisher,
  type DataReleaseV3PublishOutcome,
} from "./buyback-adjusted-ev-release-publisher.ts";
import type { DataReleaseV3ReleaseAssembler } from "./buyback-adjusted-ev-release-assembler.ts";
import type { DataReleaseV3PublicationPort } from "./buyback-adjusted-ev-release-types.ts";

/**
 * Maintenance-gated V2-to-V3 cutover runbook (task buyback-adjusted-ev/008).
 *
 * Encodes the approved clean-cutover sequence as one typed coordinator so no
 * step can run out of order and no failure path can reopen traffic against a
 * mismatched code-and-release pair:
 *
 * 1. Prepare the recomputed canonical V3 dataset and the immutable V3
 *    application artifacts BEFORE entering maintenance.
 * 2. Gate public traffic at the routing layer.
 * 3. Deploy the V3 Convex code, publish and atomically activate the V3
 *    release, and deploy the matching application build.
 * 4. Verify the private candidate origin serves exactly the activated
 *    release before any public traffic can observe it.
 * 5. Leave maintenance only after that read-back passes; on any failure,
 *    restore the V2 application and its retained release pointer first, and
 *    only then reopen traffic.
 *
 * User-owned saves and authentication records live in their existing shared
 * tables throughout: this runbook exposes no port that can purge, copy,
 * reinterpret, or dual-write them, so the sequence is structurally incapable
 * of touching user data. Old V2 code and release data stay retrievable — their
 * retirement belongs to task 013 after certification and the recorded
 * rollback window.
 */

export type PackScoutV3CutoverStep =
  | "prepare_dataset"
  | "prepare_artifacts"
  | "gate_traffic"
  | "deploy_v3_backend"
  | "publish_v3_release"
  | "deploy_v3_application"
  | "verify_candidate_origin"
  | "open_traffic"
  | "restore_v2_application"
  | "rollback_v3_release"
  | "reopen_after_failure";

export interface PackScoutV3CutoverArtifacts {
  /** Immutable, content-addressed V3 application build reference. */
  readonly applicationArtifactRef: string;
  /** Immutable V3 Convex deployment reference. */
  readonly backendArtifactRef: string;
}

/**
 * Routing-layer maintenance gate. Gating and reopening are the only public
 * traffic controls; the runbook never deploys or activates while open.
 */
export interface PackScoutV3MaintenanceGatePort {
  gatePublicTraffic(): Promise<void>;
  openPublicTraffic(): Promise<void>;
}

/** Deploys immutable artifacts and verifies the private candidate origin. */
export interface PackScoutV3DeploymentPort {
  prepareImmutableArtifacts(): Promise<PackScoutV3CutoverArtifacts>;
  deployV3Backend(backendArtifactRef: string): Promise<void>;
  deployV3Application(applicationArtifactRef: string): Promise<void>;
  /**
   * Reads the private candidate origin through the gate and reports the
   * publicReleaseId its shell status serves, proving browser provenance
   * before traffic reopens.
   */
  readCandidateOriginReleaseId(): Promise<string | null>;
  /** Restores the retained V2 application and code path. */
  restoreV2Application(): Promise<void>;
}

export type PackScoutV3CutoverResult =
  | Readonly<{
      outcome: "cut_over";
      publicReleaseId: string;
      steps: readonly PackScoutV3CutoverStep[];
      publish: DataReleaseV3PublishOutcome;
    }>
  | Readonly<{
      outcome: "aborted_before_maintenance";
      reason: string;
      steps: readonly PackScoutV3CutoverStep[];
    }>
  | Readonly<{
      outcome: "rolled_back";
      failedStep: PackScoutV3CutoverStep;
      reason: string;
      steps: readonly PackScoutV3CutoverStep[];
    }>;

export class PackScoutV3CutoverError extends Error {
  constructor(
    readonly step: PackScoutV3CutoverStep,
    message: string,
  ) {
    super(message);
    this.name = "PackScoutV3CutoverError";
  }
}

export class PackScoutV3CutoverRunbook {
  constructor(
    private readonly assembler: DataReleaseV3ReleaseAssembler,
    private readonly publication: DataReleaseV3PublicationPort,
    private readonly gate: PackScoutV3MaintenanceGatePort,
    private readonly deployment: PackScoutV3DeploymentPort,
  ) {}

  async execute(input: { readonly readAt: string }): Promise<PackScoutV3CutoverResult> {
    const steps: PackScoutV3CutoverStep[] = [];
    const record = (step: PackScoutV3CutoverStep) => {
      steps.push(step);
    };

    // Everything expensive and fallible happens before maintenance begins.
    record("prepare_dataset");
    const plan = await this.assembler.assemble(input);
    if (plan.classification !== "publish") {
      return {
        outcome: "aborted_before_maintenance",
        reason: `assembly_blocked:${plan.reason}`,
        steps,
      };
    }
    record("prepare_artifacts");
    let artifacts: PackScoutV3CutoverArtifacts;
    try {
      artifacts = await this.deployment.prepareImmutableArtifacts();
    } catch (error) {
      return {
        outcome: "aborted_before_maintenance",
        reason: `artifacts_unavailable:${String(error)}`,
        steps,
      };
    }

    record("gate_traffic");
    await this.gate.gatePublicTraffic();
    const publisher = new DataReleaseV3ReleasePublisher(this.publication);
    const preMaintenanceActive = await this.publication.activeState();
    let publish: DataReleaseV3PublishOutcome | null = null;
    try {
      record("deploy_v3_backend");
      await this.deployment.deployV3Backend(artifacts.backendArtifactRef);
      record("publish_v3_release");
      publish = await publisher.publish(plan);
      record("deploy_v3_application");
      await this.deployment.deployV3Application(artifacts.applicationArtifactRef);
      record("verify_candidate_origin");
      const servedReleaseId = await this.deployment.readCandidateOriginReleaseId();
      if (servedReleaseId !== plan.publicReleaseId) {
        throw new PackScoutV3CutoverError(
          "verify_candidate_origin",
          `candidate origin serves ${servedReleaseId ?? "nothing"}, expected ${plan.publicReleaseId}`,
        );
      }
      record("open_traffic");
      await this.gate.openPublicTraffic();
      return {
        outcome: "cut_over",
        publicReleaseId: plan.publicReleaseId,
        steps,
        publish,
      };
    } catch (error) {
      const failedStep = steps[steps.length - 1]!;
      // Restore order is fixed: V2 application first, then the retained
      // release pointer, and only then reopen traffic — never a mixed page.
      record("restore_v2_application");
      await this.deployment.restoreV2Application();
      if (
        publish?.outcome === "activated" &&
        preMaintenanceActive.activeRelease !== null
      ) {
        record("rollback_v3_release");
        await publisher.rollback({
          expectedActivePublicReleaseId: plan.publicReleaseId,
          targetPublicReleaseId:
            preMaintenanceActive.activeRelease.publicReleaseId,
        });
      }
      record("reopen_after_failure");
      await this.gate.openPublicTraffic();
      return {
        outcome: "rolled_back",
        failedStep,
        reason: error instanceof Error ? error.message : String(error),
        steps,
      };
    }
  }
}
