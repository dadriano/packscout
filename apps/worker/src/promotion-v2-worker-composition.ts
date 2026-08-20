import {
  PrismaCatalogPromotionBootstrapProofRepository,
  PrismaManifestPromotionRepository,
  PrismaProviderCatalogReleaseSourceRepository,
  PrismaProviderCatalogSettlementRepository,
  PrismaProviderPromotionRepository,
  PrismaPromotionReadinessRepository,
  type ExactPromotionOperationRecord,
  type ProviderPromotionReleaseArtifact as DatabaseProviderPromotionReleaseArtifact,
  type PackscoutPrismaClient,
} from "@packscout/database";
import {
  CatalogManifestPromotionBootstrapCoordinator,
  ManifestEligibilityService,
  ManifestPromotionRunner,
  ProviderCatalogReleaseAssembler,
  ProviderCatalogSettlementService,
  ProviderPromotionArtifactPlanResolver,
  ProviderPromotionRunner,
  PromotionOperationalReadinessService,
  SignedConvexCatalogManifestPublicationClient,
  SignedConvexProviderReleasePublicationClient,
  type ManifestEligibilitySnapshot,
  type ManifestPromotionLanePort,
  type ManifestPromotionOperationRecord,
  type ProviderPromotionOperationRecord,
  type ProviderPromotionLanePort,
  type ProviderPromotionReleaseArtifact,
  type OperationalEventService,
} from "@packscout/services";
import {
  assertPromotionV2CredentialEligibility,
  type PromotionV2WorkerConfiguration,
} from "./promotion-v2-worker-config.ts";
import {
  PromotionV2WorkerRuntime,
  type PromotionV2WorkerLogger,
  type PromotionV2WorkerSleeper,
} from "./promotion-v2-worker-runtime.ts";
import {
  ManifestPromotionOperationalReadinessSink,
  ProviderPromotionOperationalReadinessSink,
} from "./promotion-v2-operational-readiness.ts";
import { runPromotionObservabilityFanout } from
  "./promotion-observability-fanout.ts";

export interface PromotionV2WorkerCompositionInput {
  readonly configuration: PromotionV2WorkerConfiguration;
  readonly organizationId: string;
  readonly workerId: string;
  readonly database: PackscoutPrismaClient;
  readonly logger: PromotionV2WorkerLogger;
  readonly operationalEvents: Pick<
    OperationalEventService,
    | "promotionActivationDelayed"
    | "promotionFailed"
    | "promotionRecovered"
    | "promotionSettlementBlocked"
  >;
  readonly clock?: Readonly<{ now(): Date }>;
  readonly fetch?: typeof fetch;
  readonly nonce?: () => string;
  readonly sleeper?: PromotionV2WorkerSleeper;
}

function providerOperation(
  operation: ExactPromotionOperationRecord,
): ProviderPromotionOperationRecord {
  if (operation.operationKind !== "start" &&
      operation.operationKind !== "applyBatch" &&
      operation.operationKind !== "finalize" &&
      operation.operationKind !== "confirmReuse") {
    throw new Error("Persisted provider operation kind is invalid.");
  }
  return operation as ProviderPromotionOperationRecord;
}

function manifestOperation(
  operation: ExactPromotionOperationRecord,
): ManifestPromotionOperationRecord {
  if (operation.operationKind !== "activateManifest" &&
      operation.operationKind !== "refreshActiveState" &&
      operation.operationKind !== "rollback") {
    throw new Error("Persisted manifest operation kind is invalid.");
  }
  return operation as ManifestPromotionOperationRecord;
}

function providerLaneAdapter(
  repository: PrismaProviderPromotionRepository,
): ProviderPromotionLanePort {
  return {
    enqueueEvaluation: (value) => repository.enqueueEvaluation(value),
    claim: (value) => repository.claim(value),
    heartbeat: (value) => repository.heartbeat(value),
    loadCompletedHead: () => repository.loadCompletedHead(),
    async persistPreparedOperations(value) {
      const records = await repository.persistPreparedOperations(value);
      return records?.map(providerOperation) ?? null;
    },
    async listOperations(value) {
      return (await repository.listOperations(value)).map(providerOperation);
    },
    markOperationSent: (value) => repository.markOperationSent(value),
    acknowledgeOperation: (value) => repository.acknowledgeOperation(value),
    scheduleRetry: (value) => repository.scheduleRetry(value),
    recordRetryExhaustion: (value) =>
      repository.recordRetryExhaustion(value),
    recordReconciliationLoss: (value) =>
      repository.recordReconciliationLoss(value),
    complete: (value) => repository.complete(value),
    loadHealth: (value) => repository.loadHealth(value),
  };
}

function artifactAdapter(
  repository: PrismaProviderPromotionRepository,
): Readonly<{
  loadReleaseArtifact(input: Readonly<{
    publicProviderReleaseId: string;
  }>): Promise<ProviderPromotionReleaseArtifact | null>;
}> {
  return {
    async loadReleaseArtifact(value) {
      const artifact: DatabaseProviderPromotionReleaseArtifact | null =
        await repository.loadReleaseArtifact(value);
      return artifact === null ? null : {
        ...artifact,
        operations: artifact.operations.map(providerOperation),
      };
    },
  };
}

function manifestLaneAdapter(
  repository: PrismaManifestPromotionRepository,
): ManifestPromotionLanePort {
  return {
    enqueueEvaluation: (value) => repository.enqueueEvaluation(value),
    claim: (value) => repository.claim(value),
    heartbeat: (value) => repository.heartbeat(value),
    loadEvaluationSnapshot: (value) =>
      repository.loadEvaluationSnapshot(value),
    async persistPreparedOperation(value) {
      const operation = await repository.persistPreparedOperation(value);
      return operation === null ? null : manifestOperation(operation);
    },
    async listOperations(value) {
      return (await repository.listOperations(value)).map(manifestOperation);
    },
    markOperationSent: (value) => repository.markOperationSent(value),
    acknowledgeOperation: (value) => repository.acknowledgeOperation(value),
    scheduleRetry: (value) => repository.scheduleRetry(value),
    recordRetryExhaustion: (value) =>
      repository.recordRetryExhaustion(value),
    deferCasLoss: (value) => repository.deferCasLoss(value),
    complete: (value) => repository.complete(value),
    recordCasLoss: (value) => repository.recordCasLoss(value),
    loadHealth: (value) => repository.loadHealth(value),
  };
}

/** Wires constructor-bound provider lanes and the one manifest lane. */
export function createPromotionV2WorkerRuntime(
  input: PromotionV2WorkerCompositionInput,
): PromotionV2WorkerRuntime {
  const clock = input.clock ?? { now: () => new Date() };
  const settlementRepository = new PrismaProviderCatalogSettlementRepository(
    input.database,
  );
  // This explicit assignment prevents the service port's intentionally
  // untrusted `unknown` return boundary from hiding drift in the production DB
  // projection. The base snapshot must not require observation fields.
  const eligibilityRepository: Readonly<{
    loadManifestEligibilitySnapshot(value: Readonly<{
      organizationId: string;
    }>): Promise<ManifestEligibilitySnapshot | null>;
  }> = settlementRepository;
  const eligibility = new ManifestEligibilityService(eligibilityRepository, {
    organizationId: input.organizationId,
  });
  const providerRepositories = input.configuration.providerCredentials.map(
    ({ platformKey }) => new PrismaProviderPromotionRepository(input.database, {
      organizationId: input.organizationId,
      deploymentKey: input.configuration.deploymentKey,
      platformKey,
    }),
  );
  const providerTransports = input.configuration.providerCredentials.map(
    ({ platformKey, keyId, secret }) => ({
      platformKey,
      client: new SignedConvexProviderReleasePublicationClient({
        baseUrl: input.configuration.convexBaseUrl,
        keyId,
        secret,
        timeoutMilliseconds: input.configuration.requestTimeoutMilliseconds,
        now: () => clock.now(),
        fetch: input.fetch,
        nonce: input.nonce,
      }),
    }),
  );
  const providerLanes = input.configuration.providerCredentials.map(
    ({ platformKey }, index) => {
      const repository = providerRepositories[index]!;
      // Compile-time conformance against the service-owned orchestration port.
      const lane: ProviderPromotionLanePort = providerLaneAdapter(repository);
      const readinessRepository = new PrismaPromotionReadinessRepository(
        input.database,
        {
          organizationId: input.organizationId,
          deploymentKey: input.configuration.deploymentKey,
          lane: "provider",
          platformKey,
        },
      );
      const readiness = new ProviderPromotionOperationalReadinessSink(
        new PromotionOperationalReadinessService(
          input.operationalEvents,
          readinessRepository,
          clock,
          {
            organizationId: input.organizationId,
            deploymentScopeDigest: readinessRepository.deploymentScopeDigest,
            lane: "provider",
            platformKey,
            targetSource: "promotion_lane",
            monitorTechnicalSettlement: true,
          },
        ),
        input.logger,
        input.workerId,
        clock,
      );
      const checkpoints = new ProviderCatalogSettlementService(
        settlementRepository,
        { organizationId: input.organizationId, platformKey },
      );
      return new ProviderPromotionRunner({
        platformKey,
        workerId: input.workerId,
        lane,
        checkpoints,
        assembler: new ProviderCatalogReleaseAssembler(
          checkpoints,
          new PrismaProviderCatalogReleaseSourceRepository(input.database, {
            organizationId: input.organizationId,
            platformKey,
          }),
          repository,
        ),
        transport: providerTransports[index]!.client,
        clock,
        alerts: {
          async notify(alert) {
            await runPromotionObservabilityFanout(
              () => readiness.notify(alert),
              () => {
                input.logger.write({
                  level: "error",
                  event: "promotion_v2_provider_terminal_alert",
                  workerId: input.workerId,
                  platformKey: alert.platformKey,
                  attemptId: alert.attemptId,
                  failureCode: alert.failureCode,
                });
              },
            );
          },
        },
        health: readiness,
      });
    },
  );
  const manifestRepository = new PrismaManifestPromotionRepository(
    input.database,
    {
      organizationId: input.organizationId,
      deploymentKey: input.configuration.deploymentKey,
    },
  );
  const manifestLane: ManifestPromotionLanePort = manifestLaneAdapter(
    manifestRepository,
  );
  const manifestReadinessRepository = new PrismaPromotionReadinessRepository(
    input.database,
    {
      organizationId: input.organizationId,
      deploymentKey: input.configuration.deploymentKey,
      lane: "manifest",
    },
  );
  const manifestReadiness = new ManifestPromotionOperationalReadinessSink(
    new PromotionOperationalReadinessService(
      input.operationalEvents,
      manifestReadinessRepository,
      clock,
      {
        organizationId: input.organizationId,
        deploymentScopeDigest:
          manifestReadinessRepository.deploymentScopeDigest,
        lane: "manifest",
        targetSource: "promotion_lane",
        monitorTechnicalSettlement: false,
      },
    ),
    input.logger,
    input.workerId,
    clock,
  );
  const publish = input.configuration.manifestPublishCredential;
  const clear = input.configuration.manifestClearCredential;
  const manifestTransport = new SignedConvexCatalogManifestPublicationClient({
    baseUrl: input.configuration.convexBaseUrl,
    keyId: publish.keyId,
    secret: publish.secret,
    timeoutMilliseconds: input.configuration.requestTimeoutMilliseconds,
    now: () => clock.now(),
    fetch: input.fetch,
    nonce: input.nonce,
  });
  const clearTransport = new SignedConvexCatalogManifestPublicationClient({
    baseUrl: input.configuration.convexBaseUrl,
    keyId: clear.keyId,
    secret: clear.secret,
    timeoutMilliseconds: input.configuration.requestTimeoutMilliseconds,
    now: () => clock.now(),
    fetch: input.fetch,
    nonce: input.nonce,
  });
  const providerPlans = new ProviderPromotionArtifactPlanResolver(
    input.configuration.providerCredentials.map(({ platformKey }, index) => ({
      platformKey,
      artifacts: artifactAdapter(providerRepositories[index]!),
    })),
  );
  const manifestRunner = new ManifestPromotionRunner({
    workerId: input.workerId,
    lane: manifestLane,
    triggers: manifestRepository,
    providerPlans,
    transport: manifestTransport,
    clearTransport,
    clock,
    alerts: {
      async notify(alert) {
        await runPromotionObservabilityFanout(
          () => manifestReadiness.notify(alert),
          () => {
            input.logger.write({
              level: "error",
              event: "promotion_v2_manifest_terminal_alert",
              workerId: input.workerId,
              attemptId: alert.attemptId,
              failureCode: alert.failureCode,
            });
          },
        );
      },
    },
    health: manifestReadiness,
  });
  const bootstrap = new CatalogManifestPromotionBootstrapCoordinator(
    new PrismaCatalogPromotionBootstrapProofRepository(input.database, {
      organizationId: input.organizationId,
      deploymentKey: input.configuration.deploymentKey,
    }),
    manifestTransport,
    providerTransports.map(({ platformKey, client }) => ({
      platformKey,
      completedHead: (request, signal) => client.completedHead(request, signal),
    })),
    manifestRepository,
  );
  return new PromotionV2WorkerRuntime({
    workerId: input.workerId,
    eligibility,
    validateEligibility(snapshot) {
      assertPromotionV2CredentialEligibility(input.configuration, snapshot);
    },
    bootstrap,
    providerLanes,
    manifestLane: manifestRunner,
    pollIntervalMilliseconds: input.configuration.pollIntervalMilliseconds,
    clock,
    logger: input.logger,
    sleeper: input.sleeper,
  });
}
