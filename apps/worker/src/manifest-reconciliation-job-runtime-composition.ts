import {
  PrismaManifestReconciliationJobRepository,
  PrismaProviderPromotionInvocationProjectionRepository,
  promotionJobSha256,
  type CentralPrismaClient,
} from "@packscout/database";
import {
  SignedConvexCatalogManifestPublicationClient,
  type VerifiedManifestGateProofSource,
} from "@packscout/services";
import type { ManifestReconciliationJobAuthorityConfiguration } from
  "./distributed-promotion-authority-config.ts";
import {
  DistributedPromotionJobRuntime,
  type DistributedPromotionJobRuntimeLogger,
  type DistributedPromotionManualCommandVerifier,
} from "./distributed-promotion-job-runtime.ts";
import { createManifestReconciliationOneShot } from
  "./manifest-reconciliation-worker-composition.ts";
import type { PromotionJobImmediateDeliveryPort } from
  "./provider-activity-relay.ts";
import { PromotionJobRetentionCoordinator } from
  "./promotion-job-retention.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

/**
 * Production central-only composition. Provider proof acquisition remains a
 * verified relay/gateway port; no provider database client or publication
 * credential is accepted by this boundary.
 */
export function createManifestReconciliationJobRuntime(input: Readonly<{
  authority: ManifestReconciliationJobAuthorityConfiguration;
  central: CentralPrismaClient;
  proofs: VerifiedManifestGateProofSource;
  workerId: string;
  logger: DistributedPromotionJobRuntimeLogger;
  manualCommands: DistributedPromotionManualCommandVerifier;
  currentManifestClient?: SignedConvexCatalogManifestPublicationClient;
  historicalManifestStatusClients?: readonly Pick<
    SignedConvexCatalogManifestPublicationClient,
    "status"
  >[];
  pollMilliseconds?: number;
  now?: () => Date;
  randomUuid?: () => string;
  maximumMilliseconds?: number;
  maximumAttempts?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}>): Readonly<{
  runtime: DistributedPromotionJobRuntime;
  immediateDelivery: PromotionJobImmediateDeliveryPort;
}> {
  if (input.authority.kind !== "manifest_reconciliation") {
    throw new TypeError("Manifest reconciliation authority is invalid.");
  }
  const currentManifestClient = input.currentManifestClient ??
    new SignedConvexCatalogManifestPublicationClient({
      baseUrl: input.authority.convexBaseUrl,
      keyId: input.authority.credential.keyId,
      secret: input.authority.credential.secret,
      timeoutMilliseconds: input.authority.requestTimeoutMilliseconds,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
  const ledger = new PrismaManifestReconciliationJobRepository(input.central);
  const runtime = new DistributedPromotionJobRuntime({
    authority: "manifest_reconciliation",
    scopeIdentitySha256: promotionJobSha256(
      `manifest:${input.authority.deploymentKey}`,
    ),
    ledger,
    oneShot: createManifestReconciliationOneShot({
      central: input.central,
      workerId: input.workerId,
      currentManifestClient,
      historicalManifestStatusClients:
        input.historicalManifestStatusClients ?? [],
      proofs: input.proofs,
      ...(input.now === undefined ? {} : { now: input.now }),
      ...(input.randomUuid === undefined
        ? {}
        : { randomUuid: input.randomUuid }),
      ...(input.maximumMilliseconds === undefined
        ? {}
        : { maximumMilliseconds: input.maximumMilliseconds }),
      ...(input.maximumAttempts === undefined
        ? {}
        : { maximumAttempts: input.maximumAttempts }),
      ...(input.setTimer === undefined ? {} : { setTimer: input.setTimer }),
      ...(input.clearTimer === undefined
        ? {}
        : { clearTimer: input.clearTimer }),
    }),
    retention: new PromotionJobRetentionCoordinator({
      invocations: ledger,
      protectionRelease: ledger,
      projections:
        new PrismaProviderPromotionInvocationProjectionRepository(
          input.central,
        ),
    }),
    manualCommands: input.manualCommands,
    logger: input.logger,
    ...(input.pollMilliseconds === undefined
      ? {}
      : { pollMilliseconds: input.pollMilliseconds }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  const immediateDelivery: PromotionJobImmediateDeliveryPort = {
    async request(delivery) {
      if (
        delivery.authority !== "manifest_reconciliation" ||
        delivery.cause !== "provider_completion" ||
        !UUID_PATTERN.test(delivery.scopeId) ||
        delivery.sourceGeneration < 1n ||
        !SHA256_PATTERN.test(delivery.sourceEvidenceDigest) ||
        !Number.isFinite(delivery.requestedAt.getTime())
      ) throw new TypeError("Manifest reconciliation delivery scope is invalid.");
      await runtime.requestImmediateCheck();
    },
  };
  return Object.freeze({ runtime, immediateDelivery });
}
