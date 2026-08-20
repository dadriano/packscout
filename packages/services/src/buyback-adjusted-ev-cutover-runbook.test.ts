import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PackScoutV3CutoverRunbook,
  type PackScoutV3CutoverArtifacts,
  type PackScoutV3DeploymentPort,
  type PackScoutV3MaintenanceGatePort,
} from "./buyback-adjusted-ev-cutover-runbook.ts";
import { DataReleaseV3ReleaseAssembler } from "./buyback-adjusted-ev-release-assembler.ts";
import { DataReleaseV3ReleasePublisher } from "./buyback-adjusted-ev-release-publisher.ts";
import {
  InMemoryDataReleaseV3Port,
  RELEASE_READ_AT,
  buildPublishableEligibility,
  buildReleaseProduct,
  buildReleaseSnapshot,
} from "./buyback-adjusted-ev-release.test-support.ts";

const REPACK_A = "00000000-0000-5000-8000-000000000301";
const REPACK_B = "00000000-0000-5000-8000-000000000302";

function assembler(publicRepackIds: readonly string[], gross = 12_000) {
  const snapshot = buildReleaseSnapshot(
    publicRepackIds.map((publicRepackId) =>
      buildReleaseProduct({ publicRepackId }),
    ),
  );
  return new DataReleaseV3ReleaseAssembler(
    { loadCatalogSnapshot: async () => snapshot },
    {
      getPublicationEligibleRevision: async () =>
        buildPublishableEligibility(gross),
    },
  );
}

class RecordingGate implements PackScoutV3MaintenanceGatePort {
  readonly transitions: string[] = [];
  gated = false;
  async gatePublicTraffic(): Promise<void> {
    this.gated = true;
    this.transitions.push("gate");
  }
  async openPublicTraffic(): Promise<void> {
    this.gated = false;
    this.transitions.push("open");
  }
}

class StubDeployment implements PackScoutV3DeploymentPort {
  readonly calls: string[] = [];
  deployedBackend: string | null = null;
  deployedApplication: string | null = null;
  restored = false;
  candidateReleaseId: string | null = null;
  failApplicationDeploy = false;
  async prepareImmutableArtifacts(): Promise<PackScoutV3CutoverArtifacts> {
    this.calls.push("prepare");
    return {
      applicationArtifactRef: "app@sha256:aa",
      backendArtifactRef: "backend@sha256:bb",
    };
  }
  async deployV3Backend(ref: string): Promise<void> {
    this.calls.push("backend");
    this.deployedBackend = ref;
  }
  async deployV3Application(ref: string): Promise<void> {
    if (this.failApplicationDeploy) throw new Error("APP_DEPLOY_FAILED");
    this.calls.push("application");
    this.deployedApplication = ref;
  }
  async readCandidateOriginReleaseId(): Promise<string | null> {
    this.calls.push("verify");
    return this.candidateReleaseId;
  }
  async restoreV2Application(): Promise<void> {
    this.calls.push("restore");
    this.restored = true;
  }
}

test("cuts over in the approved order and reopens only after read-back passes", async () => {
  const port = new InMemoryDataReleaseV3Port();
  const gate = new RecordingGate();
  const deployment = new StubDeployment();
  const runbook = new PackScoutV3CutoverRunbook(
    assembler([REPACK_A]),
    port,
    gate,
    deployment,
  );
  // The stub candidate origin serves whatever release activates.
  const originalRead = deployment.readCandidateOriginReleaseId.bind(deployment);
  deployment.readCandidateOriginReleaseId = async () => {
    await originalRead();
    return port.state.activeRelease?.publicReleaseId ?? null;
  };
  const result = await runbook.execute({ readAt: RELEASE_READ_AT });
  assert.equal(result.outcome, "cut_over");
  if (result.outcome !== "cut_over") return;
  assert.deepEqual(result.steps, [
    "prepare_dataset",
    "prepare_artifacts",
    "gate_traffic",
    "deploy_v3_backend",
    "publish_v3_release",
    "deploy_v3_application",
    "verify_candidate_origin",
    "open_traffic",
  ]);
  assert.equal(gate.gated, false);
  // Preparation happened before the gate closed; the gate closed before any
  // deploy or activation; traffic reopened only after verification.
  assert.deepEqual(gate.transitions, ["gate", "open"]);
  assert.deepEqual(deployment.calls, [
    "prepare",
    "backend",
    "application",
    "verify",
  ]);
  assert.equal(port.state.activeRelease?.publicReleaseId, result.publicReleaseId);
});

test("a blocked dataset aborts before maintenance ever begins", async () => {
  const port = new InMemoryDataReleaseV3Port();
  const gate = new RecordingGate();
  const deployment = new StubDeployment();
  const snapshot = buildReleaseSnapshot([
    buildReleaseProduct({
      publicRepackId: REPACK_A,
      availability: "sold_out",
      soldOutAt: null,
      actionAvailability: { promo: true, repackLink: false },
      actions: { promo: { code: "SCOUT", label: "Use SCOUT" } },
    }),
  ]);
  const blockedAssembler = new DataReleaseV3ReleaseAssembler(
    { loadCatalogSnapshot: async () => snapshot },
    {
      getPublicationEligibleRevision: async () => buildPublishableEligibility(),
    },
  );
  const runbook = new PackScoutV3CutoverRunbook(
    blockedAssembler,
    port,
    gate,
    deployment,
  );
  const result = await runbook.execute({ readAt: RELEASE_READ_AT });
  assert.equal(result.outcome, "aborted_before_maintenance");
  assert.deepEqual(gate.transitions, []);
  assert.deepEqual(deployment.calls, []);
});

test("a failure after activation restores V2, rolls the pointer back, then reopens", async () => {
  const port = new InMemoryDataReleaseV3Port();
  const gate = new RecordingGate();
  // Seed an existing active release so the pointer has a retained predecessor.
  const seedPublisher = new DataReleaseV3ReleasePublisher(port);
  const seedAssembler = assembler([REPACK_A]);
  const seedPlan = await seedAssembler.assemble({ readAt: RELEASE_READ_AT });
  if (seedPlan.classification !== "publish") throw new Error("unexpected");
  await seedPublisher.publish(seedPlan);

  const deployment = new StubDeployment();
  deployment.failApplicationDeploy = true;
  const runbook = new PackScoutV3CutoverRunbook(
    assembler([REPACK_A, REPACK_B], 11_000),
    port,
    gate,
    deployment,
  );
  const result = await runbook.execute({ readAt: RELEASE_READ_AT });
  assert.equal(result.outcome, "rolled_back");
  if (result.outcome !== "rolled_back") return;
  assert.equal(result.failedStep, "deploy_v3_application");
  // Restore precedes reopening; the retained V2-era pointer is active again.
  assert.deepEqual(gate.transitions, ["gate", "open"]);
  assert.equal(deployment.restored, true);
  assert.equal(
    port.state.activeRelease?.publicReleaseId,
    seedPlan.publicReleaseId,
  );
  assert.deepEqual(result.steps.slice(-3), [
    "restore_v2_application",
    "rollback_v3_release",
    "reopen_after_failure",
  ]);
});

test("a divergent candidate origin never reopens against mismatched contracts", async () => {
  const port = new InMemoryDataReleaseV3Port();
  const gate = new RecordingGate();
  const deployment = new StubDeployment();
  deployment.candidateReleaseId = "99999999-0000-4000-8000-000000000009";
  const runbook = new PackScoutV3CutoverRunbook(
    assembler([REPACK_A]),
    port,
    gate,
    deployment,
  );
  const result = await runbook.execute({ readAt: RELEASE_READ_AT });
  assert.equal(result.outcome, "rolled_back");
  if (result.outcome !== "rolled_back") return;
  assert.equal(result.failedStep, "verify_candidate_origin");
  assert.equal(deployment.restored, true);
  // The genesis activation has no coherent predecessor, so the pointer stays
  // put while the restored V2 code path (which never reads it) serves users.
  assert.deepEqual(gate.transitions, ["gate", "open"]);
});
