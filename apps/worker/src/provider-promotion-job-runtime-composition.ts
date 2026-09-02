import {
  PrismaProviderPromotionJobRepository,
  promotionJobSha256,
  type PinnedProviderReleaseInputs,
  type ProviderPrismaClient,
} from "@packscout/database";
import {
  SignedConvexProviderReleasePublicationClient,
  type DistributedProviderReleasePublicationTransport,
} from "@packscout/services";
import {
  assertProviderPublicationJobRegistration,
  type ProviderPublicationJobAuthorityConfiguration,
} from "./distributed-promotion-authority-config.ts";
import {
  DistributedPromotionJobRuntime,
  type DistributedPromotionJobRuntimeLogger,
  type DistributedPromotionManualCommandVerifier,
} from "./distributed-promotion-job-runtime.ts";
import { createBoundProviderPromotionOneShot } from
  "./provider-promotion-one-shot-composition.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function transientBootstrapFailure(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error &&
    error.code === "DISTRIBUTED_PROMOTION_GATEWAY_UNAVAILABLE";
}

export interface ProviderPromotionImmediateDeliveryPort {
  request(input: Readonly<{
    authority: "provider_publication";
    cause: "canonical_settlement" | "central_invalidation";
    scopeId: string;
    sourceGeneration: bigint;
    sourceEvidenceDigest: string;
    requestedAt: Date;
  }>): Promise<void>;
}

/**
 * Production provider-local composition. It receives one already-pinned
 * provider client and one exact release pin; it has no central client,
 * provider directory, manifest client, or manifest credential.
 */
export function createProviderPromotionJobRuntime(input: Readonly<{
  authority: ProviderPublicationJobAuthorityConfiguration;
  provider: ProviderPrismaClient;
  pin: PinnedProviderReleaseInputs;
  loadPin: () => Promise<PinnedProviderReleaseInputs>;
  workerId: string;
  logger: DistributedPromotionJobRuntimeLogger;
  manualCommands: DistributedPromotionManualCommandVerifier;
  transport?: DistributedProviderReleasePublicationTransport;
  pollMilliseconds?: number;
  now?: () => Date;
  randomUuid?: () => string;
  maximumMilliseconds?: number;
  maximumAttempts?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}>): Readonly<{
  runtime: DistributedPromotionJobRuntime;
  immediateDelivery: ProviderPromotionImmediateDeliveryPort;
}> {
  assertProviderPublicationJobRegistration(input.authority, {
    providerId: input.pin.providerId,
  });
  if (
    input.pin.providerId.toLowerCase() !== input.authority.providerId ||
    !UUID_PATTERN.test(input.pin.providerConfigVersionId)
  ) throw new TypeError("Provider promotion pin is invalid.");
  const transport = input.transport ??
    new SignedConvexProviderReleasePublicationClient({
      baseUrl: input.authority.convexBaseUrl,
      keyId: input.authority.credential.keyId,
      secret: input.authority.credential.secret,
      timeoutMilliseconds: input.authority.requestTimeoutMilliseconds,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
  const ledger = new PrismaProviderPromotionJobRepository(input.provider);
  let lastVerifiedPin = input.pin;
  const oneShot = {
    async run(request: Parameters<ReturnType<
      typeof createBoundProviderPromotionOneShot
    >["run"]>[0]) {
      let pin: PinnedProviderReleaseInputs;
      try {
        pin = await input.loadPin();
      } catch (error) {
        if (!transientBootstrapFailure(error)) throw error;
        pin = lastVerifiedPin;
      }
      if (
        pin.providerId.toLowerCase() !== input.authority.providerId ||
        pin.providerKey !== input.pin.providerKey ||
        !UUID_PATTERN.test(pin.providerConfigVersionId)
      ) throw new TypeError("Provider promotion pin is invalid.");
      lastVerifiedPin = pin;
      return createBoundProviderPromotionOneShot({
        provider: input.provider,
        providerId: input.authority.providerId,
        pin,
        workerId: input.workerId,
        transport,
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
      }).run(request);
    },
  };
  const runtime = new DistributedPromotionJobRuntime({
    authority: "provider_publication",
    scopeIdentitySha256: promotionJobSha256(
      input.authority.providerId.toLowerCase(),
    ),
    ledger,
    oneShot,
    manualCommands: input.manualCommands,
    logger: input.logger,
    ...(input.pollMilliseconds === undefined
      ? {}
      : { pollMilliseconds: input.pollMilliseconds }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  const immediateDelivery: ProviderPromotionImmediateDeliveryPort = {
    async request(delivery) {
      if (
        delivery.authority !== "provider_publication" ||
        delivery.scopeId.toLowerCase() !== input.authority.providerId ||
        delivery.sourceGeneration < 1n ||
        !SHA256_PATTERN.test(delivery.sourceEvidenceDigest) ||
        !Number.isFinite(delivery.requestedAt.getTime())
      ) throw new TypeError("Provider promotion delivery scope is invalid.");
      await runtime.requestImmediateCheck();
    },
  };
  return Object.freeze({ runtime, immediateDelivery });
}
