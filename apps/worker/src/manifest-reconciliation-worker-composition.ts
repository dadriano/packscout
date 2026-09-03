import type { CentralPrismaClient } from "@packscout/database";
import {
  PrismaManifestActivationRepository,
  PrismaManifestGateIntentRepository,
  PrismaManifestReconciliationJobRepository,
} from "@packscout/database";
import {
  IndependentProviderManifestCoordinator,
  RotationAwareManifestCoordinatorTransport,
  type SignedConvexCatalogManifestPublicationClient,
  type VerifiedManifestGateProofSource,
} from "@packscout/services";
import { ManifestReconciliationOneShot } from
  "./manifest-reconciliation-one-shot.ts";

/**
 * Central-only composition. The proof seam is responsible for verified relay
 * reads; no provider database client or provider credential enters this
 * process. Historical role clients are status-only recovery readers.
 */
export function createManifestReconciliationOneShot(input: Readonly<{
  central: CentralPrismaClient;
  workerId: string;
  currentManifestClient: SignedConvexCatalogManifestPublicationClient;
  historicalManifestStatusClients?: readonly Pick<
    SignedConvexCatalogManifestPublicationClient,
    "status"
  >[];
  proofs: VerifiedManifestGateProofSource;
  now?: () => Date;
  randomUuid?: () => string;
  maximumMilliseconds?: number;
  maximumAttempts?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}>): ManifestReconciliationOneShot {
  const activations = new PrismaManifestActivationRepository(input.central);
  const transport = new RotationAwareManifestCoordinatorTransport(
    input.currentManifestClient,
    input.historicalManifestStatusClients ?? [],
  );
  const coordinator = new IndependentProviderManifestCoordinator({
    workerId: input.workerId,
    activations,
    transport,
    proofs: input.proofs,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  return new ManifestReconciliationOneShot({
    workerId: input.workerId,
    ledger: new PrismaManifestReconciliationJobRepository(input.central),
    gates: new PrismaManifestGateIntentRepository(input.central),
    work: coordinator,
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
  });
}
