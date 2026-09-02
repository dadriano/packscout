import {
  PrismaProviderPromotionJobRepository,
  promotionJobSha256,
  type PinnedProviderReleaseInputs,
  type ProviderPromotionImmediateDeliveryPort,
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
import {
  PROVIDER_PROMOTION_ONE_SHOT_MAXIMUM_MILLISECONDS,
} from "./provider-promotion-one-shot.ts";
import { PromotionJobRetentionCoordinator } from
  "./promotion-job-retention.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function transientBootstrapFailure(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error &&
    (error.code === "DISTRIBUTED_PROMOTION_GATEWAY_UNAVAILABLE"
      || error.code === "DISTRIBUTED_PROMOTION_GATEWAY_ABORTED");
}

function bootstrapDeadlineFailure(): Error & Readonly<{ code: string }> {
  return Object.assign(new Error("Provider promotion bootstrap timed out."), {
    code: "DISTRIBUTED_PROMOTION_GATEWAY_UNAVAILABLE",
  });
}

function bootstrapCancellationFailure(): Error & Readonly<{ code: string }> {
  return Object.assign(new Error("Provider promotion bootstrap cancelled."), {
    code: "DISTRIBUTED_PROMOTION_GATEWAY_ABORTED",
  });
}

async function loadPinBeforeDeadline(input: Readonly<{
  loadPin: (signal?: AbortSignal) => Promise<PinnedProviderReleaseInputs>;
  signal?: AbortSignal;
  deadlineAt: number;
  nowMilliseconds: () => number;
  setTimer: typeof setTimeout;
  clearTimer: typeof clearTimeout;
}>): Promise<PinnedProviderReleaseInputs> {
  const controller = new AbortController();
  let cancel!: (error: Error) => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    cancel = reject;
  });
  const cancelFromCaller = () => {
    const error = bootstrapCancellationFailure();
    controller.abort(error);
    cancel(error);
  };
  if (input.signal?.aborted === true) cancelFromCaller();
  else input.signal?.addEventListener("abort", cancelFromCaller, { once: true });
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = input.setTimer(() => {
      const error = bootstrapDeadlineFailure();
      controller.abort(error);
      reject(error);
    }, Math.max(0, input.deadlineAt - input.nowMilliseconds()));
  });
  try {
    return await Promise.race([
      input.loadPin(controller.signal),
      timeout,
      cancellation,
    ]);
  } finally {
    input.clearTimer(timer);
    input.signal?.removeEventListener("abort", cancelFromCaller);
  }
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
  loadPin: (signal?: AbortSignal) => Promise<PinnedProviderReleaseInputs>;
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
  nowMilliseconds?: () => number;
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
  const maximumMilliseconds = input.maximumMilliseconds
    ?? PROVIDER_PROMOTION_ONE_SHOT_MAXIMUM_MILLISECONDS;
  if (
    !Number.isSafeInteger(maximumMilliseconds)
    || maximumMilliseconds < 1
    || maximumMilliseconds > PROVIDER_PROMOTION_ONE_SHOT_MAXIMUM_MILLISECONDS
  ) throw new RangeError("Provider promotion runtime bound is invalid.");
  const completionReserveMilliseconds = Math.min(
    10_000,
    Math.max(1, Math.floor(maximumMilliseconds / 5)),
  );
  const nowMilliseconds = input.nowMilliseconds ?? Date.now;
  const runtimeSetTimer = input.setTimer ?? setTimeout;
  const runtimeClearTimer = input.clearTimer ?? clearTimeout;
  let lastVerifiedPin = input.pin;
  const oneShot = {
    async run(request: Parameters<ReturnType<
      typeof createBoundProviderPromotionOneShot
    >["run"]>[0]) {
      const startedAt = nowMilliseconds();
      const deadlineAt = Math.min(
        request.deadlineAt ?? Number.MAX_SAFE_INTEGER,
        startedAt + maximumMilliseconds,
      );
      // A resident already has a verified pin. Bound its freshness probe to
      // one reserve and preserve another reserve for work before completion.
      const bootstrapDeadlineAt = Math.max(
        startedAt,
        Math.min(
          startedAt + completionReserveMilliseconds,
          deadlineAt - completionReserveMilliseconds * 2,
        ),
      );
      let pin: PinnedProviderReleaseInputs;
      try {
        pin = await loadPinBeforeDeadline({
          loadPin: input.loadPin,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          deadlineAt: bootstrapDeadlineAt,
          nowMilliseconds,
          setTimer: runtimeSetTimer,
          clearTimer: runtimeClearTimer,
        });
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
        nowMilliseconds,
      }).run({ ...request, deadlineAt });
    },
  };
  const runtime = new DistributedPromotionJobRuntime({
    authority: "provider_publication",
    scopeIdentitySha256: promotionJobSha256(
      input.authority.providerId.toLowerCase(),
    ),
    ledger,
    oneShot,
    retention: new PromotionJobRetentionCoordinator({
      // Retention protection remains provider-local until the central
      // monitoring projection relay durably acknowledges the exact summary.
      invocations: ledger,
    }),
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
