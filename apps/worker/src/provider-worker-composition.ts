import { randomUUID } from "node:crypto";
import {
  PrismaWorkerPresenceRepository,
  IngestionPersistenceRepository,
  PROTECTED_PAYLOAD_RETENTION_DAYS,
  type PackscoutPrismaClient,
} from "@packscout/database";
import {
  WorkerPresenceService,
  type OperationalObservability,
} from "@packscout/services";
import {
  createProviderSourceImportComposition,
  type ProviderSourceImportComposition,
} from "./provider-source-import-composition.ts";

export {
  createProviderSourceImportComposition,
  type ProviderSourceImportComposition,
} from "./provider-source-import-composition.ts";
import { createProviderWorkerOperationalRuntime } from "./provider-worker-operational-runtime.ts";
import { createProviderWorkerEstimatedEvProcessor } from "./provider-worker-estimated-ev.ts";
import {
  createProviderWorkerPresenceObserver,
  describeWorkerInstance,
  ProviderWorkerPresence,
  resolveWorkerEffectiveSettings,
  type ProviderWorkerHeartbeatTimer,
} from "./provider-worker-presence.ts";
import { createProviderWorkerRetentionCoordinator } from "./provider-worker-retention.ts";
import type { PromotionV2WorkerRuntimePort } from
  "./promotion-v2-worker-runtime.ts";
import type {
  HeatPromotionWorkerRuntimePort,
} from "./heat-promotion-worker-runtime.ts";
import type { CatalogRetentionWorkerRuntimePort } from
  "./catalog-retention-worker-runtime.ts";
import type { ProviderWorkerConfiguration } from "./runtime-config.ts";
import {
  ProviderWorkerRuntime,
  type ProviderWorkerLogger,
} from "./provider-worker-runtime.ts";

type RuntimeConfiguration = Pick<
  ProviderWorkerConfiguration,
  | "actorPseudonymKey"
  | "credentialKey"
  | "credentialKeyVersion"
  | "environment"
  | "estimatedEvVerifiedUsdStablecoins"
  | "heartbeatIntervalMilliseconds"
  | "importRunLeaseMilliseconds"
  | "maximumClaimsPerCycle"
  | "pollIntervalMilliseconds"
  | "presenceRetentionDays"
  | "presenceStaleAfterMilliseconds"
  | "retentionBatchSize"
  | "retentionMaximumBatchesPerCycle"
  | "retentionOrganizationDiscoveryLimit"
  | "runHeartbeatStaleAfterMilliseconds"
  | "scheduleClaimLeaseMilliseconds"
  | "workerHost"
  | "workerId"
  | "workerVersion"
>;

export interface ProviderWorkerCompositionInput {
  readonly configuration: RuntimeConfiguration;
  readonly database: PackscoutPrismaClient;
  readonly logger: ProviderWorkerLogger;
  readonly observability: OperationalObservability;
  readonly promotion?: PromotionV2WorkerRuntimePort;
  readonly heatPromotion?: HeatPromotionWorkerRuntimePort;
  readonly catalogRetention?: CatalogRetentionWorkerRuntimePort;
  readonly sourceSupervisor?: Readonly<{
    start(): Promise<void>;
    stop(): Promise<void> | void;
  }>;
  readonly heartbeatTimer?: ProviderWorkerHeartbeatTimer;
}

export function createProviderWorkerRuntime(
  input: ProviderWorkerCompositionInput,
): ProviderWorkerRuntime & {
  readonly sourceImports: ProviderSourceImportComposition;
} {
  const clock = { now: () => new Date() };
  const ids = { id: randomUUID };
  // One resolved settings object drives the collaborators below and is the same
  // object the instance publishes, so the fleet view and alerting read the
  // values this process is genuinely running with.
  const effectiveSettings = resolveWorkerEffectiveSettings(input.configuration);
  // One process identity, resolved once. The presence record, the schedule
  // claim owner, the import-run lease owner, and the recomputation claim owner
  // are all this string, so the fleet view can join a stalled run or a wedged
  // claim back to the instance that is actually holding it.
  const descriptor = describeWorkerInstance(input.configuration);
  const instanceId = descriptor.instanceId;
  const presenceRepository = new PrismaWorkerPresenceRepository(input.database);
  const operational = createProviderWorkerOperationalRuntime({
    database: input.database,
    ids,
    clock,
    observability: input.observability,
  });
  const retention = createProviderWorkerRetentionCoordinator({
    database: input.database,
    ids,
    clock,
    events: operational.events,
    observability: input.observability,
    config: {
      batchSize: input.configuration.retentionBatchSize,
      maxBatchesPerCycle:
        input.configuration.retentionMaximumBatchesPerCycle,
      organizationDiscoveryLimit:
        input.configuration.retentionOrganizationDiscoveryLimit,
      pruners: [
        {
          kind: "worker_presence",
          retentionMs:
            effectiveSettings.presenceRetentionDays * 24 * 60 * 60 * 1_000,
          prune: (request) => presenceRepository.prune(request),
        },
      ],
    },
  });
  const pages = new IngestionPersistenceRepository(input.database, {
    retentionDays: PROTECTED_PAYLOAD_RETENTION_DAYS,
    actorPseudonymKey: input.configuration.actorPseudonymKey,
  });
  const sourceImports = createProviderSourceImportComposition({
    database: input.database,
    actorPseudonymKey: input.configuration.actorPseudonymKey,
  });
  const runtime = new ProviderWorkerRuntime({
    // Task 007 owns durable source schedule claims and execution. Keeping this
    // lane idle makes Task 006 request-only and prevents a legacy feed fallback.
    scheduler: { async runOnce() { return { kind: "idle" }; } },
    imports: {
      async executeImport() {
        throw new Error("Provider source execution requires the Task 007 supervisor.");
      },
      async executeNextImport() { return { kind: "idle" }; },
    },
    estimatedEv: createProviderWorkerEstimatedEvProcessor({
      database: input.database,
      canonical: pages,
      reporter: operational.reporter,
      clock,
      workerId: instanceId,
      verifiedUsdStablecoins:
        input.configuration.estimatedEvVerifiedUsdStablecoins,
    }),
    promotion: input.promotion,
    heatPromotion: input.heatPromotion,
    catalogRetention: input.catalogRetention,
    sourceSupervisor: input.sourceSupervisor,
    retention,
    presence: new ProviderWorkerPresence({
      service: new WorkerPresenceService({
        store: presenceRepository,
        clock,
        descriptor,
        effectiveSettings,
        observer: createProviderWorkerPresenceObserver(input.logger),
      }),
      heartbeatIntervalMilliseconds: effectiveSettings.heartbeatIntervalMs,
      ...(input.heartbeatTimer ? { timer: input.heartbeatTimer } : {}),
    }),
    logger: input.logger,
    workerId: instanceId,
    pollIntervalMilliseconds: input.configuration.pollIntervalMilliseconds,
    maximumClaimsPerCycle: input.configuration.maximumClaimsPerCycle,
  });
  return Object.assign(runtime, { sourceImports });
}
