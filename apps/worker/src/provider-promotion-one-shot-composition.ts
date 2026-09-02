import type {
  PinnedProviderReleaseInputs,
  ProviderDatabaseRoute,
  ProviderPrismaClient,
} from "@packscout/database";
import {
  PROMOTION_JOB_MAX_RECENT_OPERATIONS,
  PrismaProviderPromotionJobRepository,
  ProviderReleaseRepository,
  promotionJobSha256,
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
  createBoundProviderReleasePublicationExecutor,
} from "./provider-release-publication-composition.ts";
import {
  PROVIDER_PROMOTION_ONE_SHOT_MAXIMUM_MILLISECONDS,
  PROVIDER_PROMOTION_OWNERSHIP_GRACE_MILLISECONDS,
  ProviderPromotionOneShot,
  type ProviderPromotionAttemptObservation,
  type ProviderPromotionBoundary,
  type ProviderPromotionJobWorkPort,
  type ProviderPromotionOneShotRequest,
  type ProviderPromotionOneShotResult,
} from "./provider-promotion-one-shot.ts";

const RELEASE_LEASE_MILLISECONDS =
  PROVIDER_PROMOTION_ONE_SHOT_MAXIMUM_MILLISECONDS
  + PROVIDER_PROMOTION_OWNERSHIP_GRACE_MILLISECONDS;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_CODE_PATTERN = /^[A-Z0-9_]{1,128}$/u;
const RETRYABLE_WORK_FAILURE_CODES = new Set([
  "PROVIDER_RELEASE_FENCE_STALE",
  "PROVIDER_RELEASE_CANCELLED",
  "PROVIDER_RELEASE_DEADLINE",
  "PROVIDER_PROMOTION_CANCELLED",
  "PROVIDER_PROMOTION_DEADLINE",
  "PROVIDER_CONFIG_MISMATCH",
  "CATALOG_VERSION_MISSING",
  "CATALOG_VERSION_INCOMPLETE",
  "CORRELATION_MISSING",
  "CORRELATION_STALE",
  "PROVIDER_PUBLICATION_LEASE_LOST",
  "PROVIDER_PUBLICATION_DEADLINE",
  "PROVIDER_WORKER_LEASE_DEADLINE",
  "PROVIDER_PUBLICATION_AMBIGUOUS",
  "PROVIDER_PUBLICATION_TRANSPORT_FAILED",
  "PUBLICATION_CANCELLED",
  "PUBLICATION_NETWORK_ERROR",
  "PUBLICATION_TIMEOUT",
]);

export interface PinnedProviderPromotionBootstrap {
  readonly route: ProviderDatabaseRoute;
  readonly pin: PinnedProviderReleaseInputs;
}

type RoutedProviderResult<T> =
  | Readonly<{
      state: "reachable";
      providerId: string;
      value: T;
      observedAt: string;
    }>
  | Readonly<{
      state: "unreachable";
      providerId: string;
      failureCode: string;
      observedAt: string;
      retryHint: string;
    }>;

export interface ProviderPromotionPinnedGateway {
  runWithCachedProviderDatabase<T>(
    route: ProviderDatabaseRoute,
    operation: (database: ProviderPrismaClient) => Promise<T>,
  ): Promise<RoutedProviderResult<T>>;
}

export type RoutedProviderPromotionOneShotResult =
  | Readonly<{
      state: "authority_unavailable";
      providerId: string;
      failureCode: "PROVIDER_PROMOTION_AUTHORITY_UNAVAILABLE";
    }>
  | Readonly<{
      state: "database_unreachable";
      providerId: string;
      failureCode: string;
      observedAt: string;
      retryHint: string;
    }>
  | ProviderPromotionOneShotResult;

export interface BoundProviderPromotionOneShotRunner {
  run(
    request: ProviderPromotionOneShotRequest,
  ): Promise<ProviderPromotionOneShotResult>;
}

export function createBoundProviderPromotionOneShot(input: Readonly<{
  provider: ProviderPrismaClient;
  providerId: string;
  pin: PinnedProviderReleaseInputs;
  workerId: string;
  transport: DistributedProviderReleasePublicationTransport;
  now?: () => Date;
  randomUuid?: () => string;
  maximumMilliseconds?: number;
  maximumAttempts?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  nowMilliseconds?: () => number;
}>): ProviderPromotionOneShot {
  return new ProviderPromotionOneShot({
    providerId: input.providerId,
    workerId: input.workerId,
    ledger: new PrismaProviderPromotionJobRepository(input.provider),
    work: new PrismaBoundProviderPromotionWork({
      provider: input.provider,
      providerId: input.providerId,
      pin: input.pin,
      workerId: input.workerId,
      transport: input.transport,
      ...(input.now === undefined ? {} : { now: input.now }),
    }),
    ...(input.maximumMilliseconds === undefined
      ? {}
      : { maximumMilliseconds: input.maximumMilliseconds }),
    ...(input.maximumAttempts === undefined
      ? {}
      : { maximumAttempts: input.maximumAttempts }),
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.randomUuid === undefined ? {} : { randomUuid: input.randomUuid }),
    ...(input.setTimer === undefined ? {} : { setTimer: input.setTimer }),
    ...(input.clearTimer === undefined ? {} : { clearTimer: input.clearTimer }),
    ...(input.nowMilliseconds === undefined
      ? {}
      : { nowMilliseconds: input.nowMilliseconds }),
  });
}

function boundedFailureCode(error: unknown, fallback: string): string {
  if (
    error !== null
    && typeof error === "object"
    && "code" in error
    && typeof error.code === "string"
    && SAFE_CODE_PATTERN.test(error.code)
  ) return error.code;
  return fallback;
}

function retryable(error: unknown): boolean {
  return error !== null
    && typeof error === "object"
    && "retryable" in error
    && error.retryable === true;
}

function overlap(code: string): boolean {
  return code === "PROVIDER_RELEASE_LEASE_HELD"
    || code === "PROVIDER_PUBLICATION_LEASE_HELD";
}

function exactBootstrap(
  authority: ProviderPublicationJobAuthorityConfiguration,
  bootstrap: PinnedProviderPromotionBootstrap,
): boolean {
  const { pin, route } = bootstrap;
  try {
    assertProviderPublicationJobRegistration(authority, {
      providerId: pin.providerId,
    });
  } catch {
    return false;
  }
  return UUID_PATTERN.test(pin.providerId)
    && route.target.providerId.toLowerCase() === pin.providerId.toLowerCase()
    && route.target.providerKey === pin.providerKey
    && route.configVersionId === pin.providerConfigVersionId;
}

function attemptOwner(workerId: string, runId: string): string {
  return `provider-promotion:${promotionJobSha256(workerId).slice(0, 24)}:${runId}`;
}

function boundedReadOptions(deadlineAt: number | undefined): Readonly<{
  maxWait: number;
  timeout: number;
}> | undefined {
  if (deadlineAt === undefined) return undefined;
  const available = Math.floor(deadlineAt - Date.now() - 50);
  const maxWait = Math.min(1_000, Math.max(1, Math.floor(available / 5)));
  const timeout = Math.min(30_000, available - maxWait);
  if (timeout < 1) {
    throw Object.assign(new Error("Provider read deadline reached."), {
      code: "PROVIDER_PROMOTION_DEADLINE",
    });
  }
  return { maxWait, timeout };
}

function providerReadTransactionExpired(error: unknown): boolean {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && (error.code === "P2024" || error.code === "P2028");
}

async function boundedProviderRead<T>(
  deadlineAt: number | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (deadlineAt !== undefined && providerReadTransactionExpired(error)) {
      throw Object.assign(new Error("Provider read deadline reached."), {
        code: "PROVIDER_PROMOTION_DEADLINE",
      });
    }
    throw error;
  }
}

export class PrismaBoundProviderPromotionWork
implements ProviderPromotionJobWorkPort {
  constructor(private readonly dependencies: Readonly<{
    provider: ProviderPrismaClient;
    providerId: string;
    pin: PinnedProviderReleaseInputs;
    workerId: string;
    transport: DistributedProviderReleasePublicationTransport;
    now?: () => Date;
  }>) {}

  async readBoundary(
    signal?: AbortSignal,
    deadlineAt?: number,
  ): Promise<ProviderPromotionBoundary> {
    if (signal?.aborted) {
      throw Object.assign(new Error("Provider read cancelled."), {
        code: "PROVIDER_PROMOTION_CANCELLED",
      });
    }
    const options = boundedReadOptions(deadlineAt);
    const [identity, lane, publication] = await boundedProviderRead(
      deadlineAt,
      () => this.dependencies.provider.$transaction(
        async (transaction) => Promise.all([
        transaction.database_identity.findUniqueOrThrow({
          where: { singleton_key: true },
          select: { provider_id: true, provider_key: true },
        }),
        transaction.promotion_ledger.findUniqueOrThrow({
          where: { singleton_key: true },
          select: { last_sequence: true },
        }),
        transaction.provider_publication_state.findUniqueOrThrow({
          where: { singleton_key: true },
          select: { completed_through_change_sequence: true },
        }),
        ]),
        options,
      ),
    );
    if (signal?.aborted || deadlineAt !== undefined && Date.now() >= deadlineAt) {
      throw Object.assign(new Error("Provider read deadline reached."), {
        code: signal?.aborted
          ? "PROVIDER_PROMOTION_CANCELLED"
          : "PROVIDER_PROMOTION_DEADLINE",
      });
    }
    if (
      identity.provider_id.toLowerCase() !==
        this.dependencies.providerId.toLowerCase()
      || identity.provider_id.toLowerCase() !==
        this.dependencies.pin.providerId.toLowerCase()
      || identity.provider_key !== this.dependencies.pin.providerKey
    ) {
      throw Object.assign(new Error("Provider identity is not pinned."), {
        code: "PROVIDER_PROMOTION_IDENTITY_MISMATCH",
      });
    }
    return {
      providerId: identity.provider_id,
      providerKey: identity.provider_key,
      lanePosition: lane.last_sequence,
      settledPosition: publication.completed_through_change_sequence,
    };
  }

  async attempt(input: Readonly<{
    runId: string;
    attemptId: string;
    targetPosition: bigint;
    retryCount: number;
    deadlineAt: number;
    cleanupDeadlineAt: number;
    signal: AbortSignal;
  }>): Promise<ProviderPromotionAttemptObservation> {
    const releases = new ProviderReleaseRepository(this.dependencies.provider);
    const owner = attemptOwner(this.dependencies.workerId, input.runId);
    let providerReleaseId: string | null = null;
    try {
      const assembly = await releases.assemble({
        workerId: owner,
        leaseMilliseconds: RELEASE_LEASE_MILLISECONDS,
        pin: this.dependencies.pin,
        deadlineAt: input.deadlineAt,
        signal: input.signal,
      });
      providerReleaseId = assembly.release.id;
      if (assembly.selectedThroughChangeSequence < input.targetPosition) {
        throw Object.assign(new Error("Provider assembly missed its target."), {
          code: "PROVIDER_RELEASE_TARGET_DRIFT",
          retryable: true,
        });
      }
      const publication = await createBoundProviderReleasePublicationExecutor({
        provider: this.dependencies.provider,
        workerId: owner,
        transport: this.dependencies.transport,
        leaseMilliseconds: RELEASE_LEASE_MILLISECONDS,
        ...(this.dependencies.now === undefined
          ? {}
          : { now: this.dependencies.now }),
      }).publish(
        assembly,
        input.signal,
        input.deadlineAt,
        input.cleanupDeadlineAt,
      );
      const operations = await this.operationEvidence(
        providerReleaseId,
        input.deadlineAt,
        input.signal,
      );
      return {
        disposition: "completed",
        observedState: publication.reusedCompleteRelease
          ? "reused"
          : "complete",
        confirmedPosition: publication.confirmedThroughChangeSequence,
        safeFailureCode: null,
        publicReleaseId: publication.publicProviderReleaseId,
        releaseFingerprint: publication.providerReleaseFingerprint,
        ...operations,
      };
    } catch (error) {
      const code = boundedFailureCode(
        error,
        "PROVIDER_PROMOTION_ATTEMPT_FAILED",
      );
      const operations = providerReleaseId === null
        ? this.emptyOperationEvidence()
        : await this.operationEvidence(
            providerReleaseId,
            input.deadlineAt,
            input.signal,
          ).catch(() =>
            this.emptyOperationEvidence()
          );
      const shouldRetry = retryable(error)
        || input.signal.aborted
        || RETRYABLE_WORK_FAILURE_CODES.has(code);
      return {
        disposition: overlap(code)
          ? "overlap"
          : shouldRetry
            ? "retryable_failure"
            : "blocked",
        observedState: overlap(code)
          ? "coalesced"
          : shouldRetry
            ? "retry_wait"
            : "blocked",
        confirmedPosition: null,
        safeFailureCode: code,
        publicReleaseId: null,
        releaseFingerprint: null,
        ...operations,
      };
    }
  }

  private emptyOperationEvidence(): Readonly<{
    totalOperationCount: number;
    orderedOperationDigest: string;
    recentOperations: readonly never[];
  }> {
    return {
      totalOperationCount: 0,
      orderedOperationDigest: promotionJobSha256(""),
      recentOperations: [],
    };
  }

  private async operationEvidence(
    providerReleaseId: string,
    deadlineAt: number,
    signal: AbortSignal,
  ) {
    if (signal.aborted) {
      throw Object.assign(new Error("Provider evidence read cancelled."), {
        code: "PROVIDER_PROMOTION_CANCELLED",
      });
    }
    const rows = await boundedProviderRead(
      deadlineAt,
      () => this.dependencies.provider.$transaction(
        (transaction) => transaction.provider_publication_operations.findMany({
          where: { provider_release_id: providerReleaseId },
          select: {
            id: true,
            operation_kind: true,
            batch_index: true,
            request_digest: true,
            state: true,
            attempt_count: true,
            last_attempted_at: true,
            requested_at: true,
            completed_at: true,
            receipt: { select: { response_digest: true } },
          },
        }),
        boundedReadOptions(deadlineAt),
      ),
    );
    const rank = new Map([
      ["start", 0],
      ["applyBatch", 1],
      ["finalize", 2],
      ["confirmReuse", 3],
      ["block", 4],
    ]);
    rows.sort((left, right) =>
      (rank.get(left.operation_kind) ?? 99)
        - (rank.get(right.operation_kind) ?? 99)
      || (left.batch_index ?? -1) - (right.batch_index ?? -1)
      || left.requested_at.getTime() - right.requested_at.getTime()
      || left.id.localeCompare(right.id)
    );
    const operations = rows.map((row, operationIndex) => ({
      operationIndex,
      operationKind: row.operation_kind,
      state: row.state === "accepted"
        ? "acknowledged" as const
        : row.attempt_count > 0
          ? "sent" as const
          : "pending" as const,
      sendCount: row.attempt_count,
      sentAt: row.last_attempted_at,
      acknowledgedAt: row.state === "accepted" ? row.completed_at : null,
      operationIdDigest: promotionJobSha256(row.id),
      requestDigest: row.request_digest,
      receiptDigest: row.receipt?.response_digest ?? null,
    }));
    const orderedOperationDigest = promotionJobSha256(operations.map(
      (operation) => [
        operation.operationIndex,
        operation.operationKind,
        operation.state,
        operation.sendCount,
        operation.operationIdDigest,
        operation.requestDigest,
        operation.receiptDigest ?? "",
      ].join(":"),
    ).join("\n"));
    return {
      totalOperationCount: operations.length,
      orderedOperationDigest,
      recentOperations: operations.slice(-PROMOTION_JOB_MAX_RECENT_OPERATIONS),
    };
  }
}

/**
 * Resolves one pre-authorized provider bootstrap, validates it against the
 * credential-pinned job identity, then runs only inside that cached route.
 * The provider loop holds no central client and remains valid after bootstrap.
 */
export async function runPinnedProviderPromotionOnce(input: Readonly<{
  authority: ProviderPublicationJobAuthorityConfiguration;
  workerId: string;
  request: ProviderPromotionOneShotRequest;
  dependencies: Readonly<{
    bootstrapProvider(input: Readonly<{
      providerId: string;
    }>): Promise<PinnedProviderPromotionBootstrap | null>;
    gateway: ProviderPromotionPinnedGateway;
    createTransport?: (
      authority: ProviderPublicationJobAuthorityConfiguration,
    ) => DistributedProviderReleasePublicationTransport;
    fetch?: typeof fetch;
    nonce?: () => string;
    now?: () => Date;
    randomUuid?: () => string;
    maximumMilliseconds?: number;
    maximumAttempts?: number;
    setTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
    /** Focused composition seam; production uses the concrete bound runner. */
    createBoundRunner?: (input: Readonly<{
      provider: ProviderPrismaClient;
      providerId: string;
      pin: PinnedProviderReleaseInputs;
      workerId: string;
      transport: DistributedProviderReleasePublicationTransport;
    }>) => BoundProviderPromotionOneShotRunner;
  }>;
}>): Promise<RoutedProviderPromotionOneShotResult> {
  const bootstrap = await input.dependencies.bootstrapProvider({
    providerId: input.authority.providerId,
  }).catch(() => null);
  if (bootstrap === null || !exactBootstrap(input.authority, bootstrap)) {
    return {
      state: "authority_unavailable",
      providerId: input.authority.providerId,
      failureCode: "PROVIDER_PROMOTION_AUTHORITY_UNAVAILABLE",
    };
  }
  const transport = input.dependencies.createTransport?.(input.authority)
    ?? new SignedConvexProviderReleasePublicationClient({
      baseUrl: input.authority.convexBaseUrl,
      keyId: input.authority.credential.keyId,
      secret: input.authority.credential.secret,
      timeoutMilliseconds: input.authority.requestTimeoutMilliseconds,
      ...(input.dependencies.fetch === undefined
        ? {}
        : { fetch: input.dependencies.fetch }),
      ...(input.dependencies.nonce === undefined
        ? {}
        : { nonce: input.dependencies.nonce }),
      ...(input.dependencies.now === undefined
        ? {}
        : { now: input.dependencies.now }),
    });
  const routed = await input.dependencies.gateway
    .runWithCachedProviderDatabase(bootstrap.route, async (provider) => {
      const runner = input.dependencies.createBoundRunner?.({
        provider,
        providerId: input.authority.providerId,
        pin: bootstrap.pin,
        workerId: input.workerId,
        transport,
      }) ?? createBoundProviderPromotionOneShot({
        provider,
        providerId: input.authority.providerId,
        pin: bootstrap.pin,
        workerId: input.workerId,
        transport,
        ...(input.dependencies.maximumMilliseconds === undefined
          ? {}
          : { maximumMilliseconds: input.dependencies.maximumMilliseconds }),
        ...(input.dependencies.maximumAttempts === undefined
          ? {}
          : { maximumAttempts: input.dependencies.maximumAttempts }),
        ...(input.dependencies.now === undefined
          ? {}
          : { now: input.dependencies.now }),
        ...(input.dependencies.randomUuid === undefined
          ? {}
          : { randomUuid: input.dependencies.randomUuid }),
        ...(input.dependencies.setTimer === undefined
          ? {}
          : { setTimer: input.dependencies.setTimer }),
        ...(input.dependencies.clearTimer === undefined
          ? {}
          : { clearTimer: input.dependencies.clearTimer }),
      });
      return runner.run(input.request);
    });
  if (routed.state === "unreachable") {
    return {
      state: "database_unreachable",
      providerId: input.authority.providerId,
      failureCode: routed.failureCode,
      observedAt: routed.observedAt,
      retryHint: routed.retryHint,
    };
  }
  return routed.value;
}
