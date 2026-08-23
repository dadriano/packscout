import { createHmac, randomUUID } from "node:crypto";
import {
  PrismaEmailMessageOutboxRepository,
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
  createPostmarkEmailDeliveryAdapter,
  createProviderMappingAdapterRegistryFromManifest,
  DefaultProviderImportPagePlanner,
  EmailDeliveryAdapterRegistry,
  EmailDeliveryService,
  EventProjectionService,
  HmacProviderActorPseudonymizer,
  HttpCursorAdapter,
  ProviderImportService,
  ProviderImportWorkerService,
  ProviderProjectionService,
  ProviderSchedulerService,
  ProviderTransportAdapterRegistry,
  resolveMessageCatalogueOrigins,
  WorkerPresenceService,
  type OperationalObservability,
  type ProviderActorKeyer,
} from "@packscout/services";
import { createProviderWorkerOperationalRuntime } from "./provider-worker-operational-runtime.ts";
import { createProviderWorkerEstimatedEvProcessor } from "./provider-worker-estimated-ev.ts";
import { createProviderWorkerMessageOutboxProcessor } from "./provider-worker-message-outbox.ts";
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
  | "messageOutboxBackoffBaseMilliseconds"
  | "messageOutboxBackoffCapMilliseconds"
  | "messageOutboxBatchSize"
  | "messageOutboxLeaseMilliseconds"
  | "messageOutboxMaximumAttempts"
  | "messageOutboxPerRecipientLimit"
  | "messageOutboxPollMilliseconds"
  | "messageOutboxRetentionDays"
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
  /** Delivery mode, provider credentials, and public origins read here. */
  readonly env?: NodeJS.ProcessEnv;
  readonly logger: ProviderWorkerLogger;
  readonly observability: OperationalObservability;
  readonly promotion?: PromotionV2WorkerRuntimePort;
  readonly heatPromotion?: HeatPromotionWorkerRuntimePort;
  readonly catalogRetention?: CatalogRetentionWorkerRuntimePort;
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
  // One process identity, resolved once. The presence record, the schedule
  // claim owner, the import-run lease owner, and the recomputation claim owner
  // are all this string, so the fleet view can join a stalled run or a wedged
  // claim back to the instance that is actually holding it.
  const descriptor = describeWorkerInstance(input.configuration);
  const instanceId = descriptor.instanceId;
  const presenceRepository = new PrismaWorkerPresenceRepository(input.database);
  const environment = input.env ?? process.env;
  const outboxRepository = new PrismaEmailMessageOutboxRepository(
    input.database,
  );
  const operational = createProviderWorkerOperationalRuntime({
    database: input.database,
    ids,
    clock,
    observability: input.observability,
    // Alerts raised by pipeline work also reach operator email, enqueued on
    // the same outbox the drain below delivers; routing and its off switch
    // are server-side settings resolved from this environment.
    alertEmail: { env: environment, queue: outboxRepository },
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
        {
          // Delivered message history ages out with the platform's other
          // fleet-scoped records; the repository itself refuses to touch an
          // intent that is still pending or retrying.
          kind: "email_message_history",
          retentionMs:
            input.configuration.messageOutboxRetentionDays *
            24 * 60 * 60 * 1_000,
          prune: (request) => outboxRepository.pruneHistory(request),
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
      workerId: instanceId,
      verifiedUsdStablecoins:
        input.configuration.estimatedEvVerifiedUsdStablecoins,
    }),
    promotion: input.promotion,
    heatPromotion: input.heatPromotion,
    catalogRetention: input.catalogRetention,
    retention,
    messageOutbox: createProviderWorkerMessageOutboxProcessor({
      queue: outboxRepository,
      delivery: new EmailDeliveryService(
        new EmailDeliveryAdapterRegistry([
          createPostmarkEmailDeliveryAdapter(),
        ]),
        { env: environment, clock },
      ),
      origins: resolveMessageCatalogueOrigins(environment),
      clock,
      workerId: instanceId,
      settings: {
        batchSize: input.configuration.messageOutboxBatchSize,
        perRecipientLimit: input.configuration.messageOutboxPerRecipientLimit,
        leaseMilliseconds: input.configuration.messageOutboxLeaseMilliseconds,
        maximumAttempts: input.configuration.messageOutboxMaximumAttempts,
        backoffBaseMilliseconds:
          input.configuration.messageOutboxBackoffBaseMilliseconds,
        backoffCapMilliseconds:
          input.configuration.messageOutboxBackoffCapMilliseconds,
        pollIntervalMilliseconds:
          input.configuration.messageOutboxPollMilliseconds,
      },
    }),
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
}
