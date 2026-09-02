import {
  catalogBridgeConfigurationPlan,
  catalogBridgeProvider,
  refuseCatalogBridge,
  type CatalogBridgePrivatePreparedState,
} from "./dataforrest-catalog-bridge-plan.mts";
import type { CatalogBridgeDrainProcessObservation } from
  "./dataforrest-catalog-bridge-drain-policy.mts";
import type {
  CatalogBridgeCatalogLiveDatabaseAdapter,
  CatalogBridgeRecoveryPauseProof,
} from "./dataforrest-catalog-bridge-catalog-live-database.mts";
import type { CatalogBridgeCatalogLivePolicy } from
  "./dataforrest-catalog-bridge-catalog-live-policy.mts";

type EventDatabase = Pick<CatalogBridgeCatalogLiveDatabaseAdapter,
  "readEventDatabaseBoundary" | "admitEventResumeRun" | "readResumeObservation" |
  "pauseResidentForRecovery" | "proveResidentRecoveryPaused" |
  "ensureResidentOfflineAndPaused">;
type EventBoundary = Awaited<ReturnType<EventDatabase["readEventDatabaseBoundary"]>>;

export interface CatalogBridgeEventLiveDependencies {
  readonly database: EventDatabase;
  readonly bootstrap: Readonly<{
    check(): Promise<void>;
    bootstrap(): Promise<CatalogBridgeDrainProcessObservation>;
  }>;
  readonly observeProcess: () => Promise<CatalogBridgeDrainProcessObservation>;
  readonly bootoutExact: (input: Readonly<{
    launchdLabel: string;
    expectedPid: number;
    expectedProcessIdentitySha256: string;
    authorize: () => Promise<CatalogBridgeDrainProcessObservation>;
  }>) => Promise<void>;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

function processOffline(value: CatalogBridgeDrainProcessObservation,
  label: string, port: number): boolean {
  return value.launchdLabel === label && value.residencyPort === port &&
    value.launchdLoaded === false && value.processCount === 0 && value.pids.length === 0 &&
    value.processIdentitySha256 === null && value.residencyPortListening === false;
}

function assertExactOnlineProcess(value: CatalogBridgeDrainProcessObservation,
  label: string, port: number): Readonly<{ pid: number; identity: string }> {
  const pid = value.pids[0];
  if (value.launchdLabel !== label || value.residencyPort !== port || !value.launchdLoaded ||
    value.processCount !== 1 || value.pids.length !== 1 || pid === undefined ||
    value.processIdentitySha256 === null || !value.residencyPortListening) {
    refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RECOVERY_PROCESS_NOT_EXACT");
  }
  return Object.freeze({ pid, identity: value.processIdentitySha256 });
}

function settledPausedBoundary(value: EventBoundary): boolean {
  return value.runtimeState === "paused" && value.activeRunCount === 0 &&
    value.actionableCommandCount === 0 && value.importLeaseOwner === null &&
    value.importLeaseHeartbeatAt === null && value.importLeaseExpiresAt === null &&
    value.otherActiveTransactionCount === 0;
}

export function createCatalogBridgeEventLiveOrchestrator(input: Readonly<{
  policy: CatalogBridgeCatalogLivePolicy;
  state: CatalogBridgePrivatePreparedState;
  dependencies: CatalogBridgeEventLiveDependencies;
}>): Readonly<{
  readEventBoundary(): Promise<Readonly<EventBoundary &
    { stagedLaunchAgentSha256: string }>>;
  resumeResident(eventInput: Readonly<{ cursorRestoreReceiptDigest: string;
    expectedProviderRowVersion: string; expectedRuntimeRowVersion: string;
    restoredCursorHash: string }>): Promise<NonNullable<Awaited<
      ReturnType<EventDatabase["readResumeObservation"]>>>>;
  readResumed(): ReturnType<EventDatabase["readResumeObservation"]>;
  ensureResidentOfflineAndPaused(): Promise<void>;
}> {
  const definition = catalogBridgeProvider(input.state.providerKey);
  const plan = catalogBridgeConfigurationPlan(input.state);
  const wait = input.dependencies.wait ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  const safeRecovery = async (): Promise<void> => {
    const initialProcess = await input.dependencies.observeProcess();
    if (processOffline(initialProcess, definition.launchdLabel, definition.residencyPort)) {
      const boundary = await input.dependencies.database.readEventDatabaseBoundary();
      if (settledPausedBoundary(boundary)) {
        await input.dependencies.database.ensureResidentOfflineAndPaused();
        return;
      }
      if (boundary.runtimeState === "idle" && boundary.activeRunCount === 1 &&
        boundary.actionableCommandCount === 0 && boundary.importLeaseOwner === null &&
        boundary.importLeaseHeartbeatAt === null && boundary.importLeaseExpiresAt === null &&
        boundary.otherActiveTransactionCount === 0) {
        await input.dependencies.bootstrap.bootstrap();
      } else if (boundary.runtimeState === "idle" && boundary.activeRunCount === 0 &&
        boundary.actionableCommandCount === 0 && boundary.importLeaseOwner === null &&
        boundary.importLeaseHeartbeatAt === null && boundary.importLeaseExpiresAt === null &&
        boundary.otherActiveTransactionCount === 0) {
        const proof = await input.dependencies.database.pauseResidentForRecovery();
        await input.dependencies.database.proveResidentRecoveryPaused(proof);
        await input.dependencies.database.ensureResidentOfflineAndPaused();
        return;
      } else {
        refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RECOVERY_OFFLINE_WORK_CHANGED");
      }
    }

    const proof = await input.dependencies.database.pauseResidentForRecovery();
    const exactProcess = await input.dependencies.observeProcess();
    const exact = assertExactOnlineProcess(exactProcess,
      definition.launchdLabel, definition.residencyPort);
    await input.dependencies.database.proveResidentRecoveryPaused(proof);
    await input.dependencies.bootoutExact({ launchdLabel: definition.launchdLabel,
      expectedPid: exact.pid, expectedProcessIdentitySha256: exact.identity,
      authorize: async () => {
        await input.dependencies.database.proveResidentRecoveryPaused(proof);
        return input.dependencies.observeProcess();
      } });
    await input.dependencies.database.proveResidentRecoveryPaused(proof);
    await input.dependencies.database.ensureResidentOfflineAndPaused();
  };

  return Object.freeze({
    async readEventBoundary() {
      await input.dependencies.bootstrap.check();
      return Object.freeze({ ...await input.dependencies.database.readEventDatabaseBoundary(),
        stagedLaunchAgentSha256: input.policy.successorLaunchAgent.fileSha256 });
    },
    async resumeResident(eventInput) {
      const initialProcess = await input.dependencies.observeProcess();
      const initiallyOffline = processOffline(initialProcess,
        definition.launchdLabel, definition.residencyPort);
      if (!initiallyOffline) {
        assertExactOnlineProcess(initialProcess, definition.launchdLabel, definition.residencyPort);
      }
      const boundary = await input.dependencies.database.readEventDatabaseBoundary();
      const originalPaused = initiallyOffline && settledPausedBoundary(boundary);
      const operationOwnedPaused = initiallyOffline && boundary.runtimeState === "paused" &&
        boundary.activeRunCount === 0 && boundary.actionableCommandCount === 0 &&
        boundary.importLeaseOwner === input.policy.utility.workerId &&
        boundary.importLeaseHeartbeatAt !== null && boundary.importLeaseExpiresAt !== null &&
        boundary.otherActiveTransactionCount === 0;
      const exactAdmissionCandidate = boundary.activeConfigId === plan.eventSuccessor.id &&
        boundary.cachedConfigId === plan.eventSuccessor.id &&
        (boundary.runtimeState === "idle" ||
          (!initiallyOffline && boundary.runtimeState === "running"));
      if (boundary.residentOffline !== initiallyOffline ||
        boundary.activeConfigId !== plan.eventSuccessor.id ||
        boundary.cachedConfigId !== plan.eventSuccessor.id ||
        (!originalPaused && !operationOwnedPaused && !exactAdmissionCandidate)) {
        refuseCatalogBridge("CATALOG_BRIDGE_EVENT_BOOTSTRAP_BOUNDARY_CHANGED");
      }
      await input.dependencies.database.admitEventResumeRun({ ...eventInput, process: initialProcess });
      const process = initiallyOffline ? await input.dependencies.bootstrap.bootstrap() : initialProcess;
      assertExactOnlineProcess(process, definition.launchdLabel, definition.residencyPort);
      for (let index = 0;
        index < input.policy.successorLaunchAgent.startupMaximumObservations; index += 1) {
        const observation = await input.dependencies.database.readResumeObservation(
          await input.dependencies.observeProcess());
        if (observation !== null) return observation;
        await wait(input.policy.successorLaunchAgent.startupPollMilliseconds);
      }
      return refuseCatalogBridge("CATALOG_BRIDGE_EVENT_STARTUP_TIMEOUT");
    },
    readResumed: async () => input.dependencies.database.readResumeObservation(
      await input.dependencies.observeProcess()),
    ensureResidentOfflineAndPaused: safeRecovery,
  });
}
