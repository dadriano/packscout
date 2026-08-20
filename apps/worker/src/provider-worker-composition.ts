import { createHmac, randomUUID } from "node:crypto";
import {
  PrismaImportRunRepository,
  PrismaProviderConfigurationRepository,
  PrismaProviderHealthRepository,
  PrismaProviderScheduleRepository,
  PrismaWorkerPresenceRepository,
  IngestionPersistenceRepository,
  PROTECTED_PAYLOAD_RETENTION_DAYS,
  type PackscoutPrismaClient,
} from "@packscout/database";
import {
  AesGcmProviderCredentialCipher,
  CatalogProjectionService,
  createProviderMappingAdapterRegistryFromManifest,
  DefaultProviderImportPagePlanner,
  EventProjectionService,
  HmacProviderActorPseudonymizer,
  HttpCursorAdapter,
  ProviderImportService,
  ProviderImportWorkerService,
  ProviderProjectionService,
  ProviderSchedulerService,
  ProviderTransportAdapterRegistry,
  WorkerPresenceService,
  type OperationalObservability,
  type ProviderActorKeyer,
} from "@packscout/services";
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
  readonly heartbeatTimer?: ProviderWorkerHeartbeatTimer;
}

function createActorKeyer(key: Uint8Array): ProviderActorKeyer {
  const secret = Buffer.from(key);
  if (secret.byteLength < 32) {
    throw new Error("Provider actor key must be at least 32 bytes.");
  }
  return {
    keyFor({ organizationId, operatorId }) {
      return `actor:v1:${createHmac("sha256", secret)
        .update(
          `packscout-provider-request:v1\u0000${organizationId}\u0000${operatorId}`,
        )
        .digest("hex")}`;
    },
  };
}

export function createProviderWorkerRuntime(
  input: ProviderWorkerCompositionInput,
): ProviderWorkerRuntime {
  const clock = { now: () => new Date() };
  const ids = { id: randomUUID };
  // One resolved settings object drives the collaborators below and is the same
  // object the instance publishes, so the fleet view and alerting read the
  // values this process is genuinely running with.
  const effectiveSettings = resolveWorkerEffectiveSettings(input.configuration);
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
  const runs = new PrismaImportRunRepository(input.database);
  const pages = new IngestionPersistenceRepository(input.database, {
    retentionDays: PROTECTED_PAYLOAD_RETENTION_DAYS,
    actorPseudonymKey: input.configuration.actorPseudonymKey,
  });
  const imports = new ProviderImportService({
    runs,
    revisions: new PrismaProviderConfigurationRepository(input.database),
    pages,
    transportAdapters: new ProviderTransportAdapterRegistry([
      new HttpCursorAdapter(),
    ]),
    pagePlanner: new DefaultProviderImportPagePlanner(
      createProviderMappingAdapterRegistryFromManifest(),
      new ProviderProjectionService(
        new CatalogProjectionService(),
        new EventProjectionService(
          new HmacProviderActorPseudonymizer(
            input.configuration.actorPseudonymKey,
          ),
        ),
      ),
    ),
    credentialCipher: new AesGcmProviderCredentialCipher({
      primaryVersion: input.configuration.credentialKeyVersion,
      keys: new Map([
        [
          input.configuration.credentialKeyVersion,
          input.configuration.credentialKey,
        ],
      ]),
    }),
    actorKeyer: createActorKeyer(input.configuration.actorPseudonymKey),
    clock,
    ids,
    environment: input.configuration.environment,
    leaseDurationMs: effectiveSettings.importRunLeaseMs,
  });
  return new ProviderWorkerRuntime({
    scheduler: new ProviderSchedulerService({
      schedules: new PrismaProviderScheduleRepository(input.database),
      imports,
      clock,
      leaseMilliseconds: effectiveSettings.scheduleClaimLeaseMs,
    }),
    imports: new ProviderImportWorkerService(
      imports,
      new PrismaProviderHealthRepository(input.database),
      {
        events: operational.events,
        reporter: operational.reporter,
      },
    ),
    estimatedEv: createProviderWorkerEstimatedEvProcessor({
      database: input.database,
      canonical: pages,
      reporter: operational.reporter,
      clock,
      workerId: input.configuration.workerId,
      verifiedUsdStablecoins:
        input.configuration.estimatedEvVerifiedUsdStablecoins,
    }),
    retention,
    presence: new ProviderWorkerPresence({
      service: new WorkerPresenceService({
        store: presenceRepository,
        clock,
        descriptor: describeWorkerInstance(input.configuration),
        effectiveSettings,
        observer: createProviderWorkerPresenceObserver(input.logger),
      }),
      heartbeatIntervalMilliseconds: effectiveSettings.heartbeatIntervalMs,
      ...(input.heartbeatTimer ? { timer: input.heartbeatTimer } : {}),
    }),
    logger: input.logger,
    workerId: input.configuration.workerId,
    pollIntervalMilliseconds: input.configuration.pollIntervalMilliseconds,
    maximumClaimsPerCycle: input.configuration.maximumClaimsPerCycle,
  });
}
