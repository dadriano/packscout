import {
  ProviderAdapterRegistryError,
  ProviderTransportAdapterRegistry,
} from "./provider-adapter-registry.ts";
import {
  ProviderTransportRequestError,
  type NormalizedProviderTransportFailure,
  type ProviderAuth,
  type ProviderTransportAdapter,
} from "./provider-adapter.ts";
import type {
  ProviderActor,
  ProviderActorKeyer,
  ProviderClock,
  ProviderIdSource,
} from "./provider-configuration-service.ts";
import type { ProviderCredentialCipher } from "./provider-credential-cipher.ts";
import {
  ProviderEndpointPolicyError,
  validateProviderEndpoint,
  type ProviderRuntimeEnvironment,
} from "./provider-endpoint-policy.ts";
import { ProviderImportPlanningError } from "./provider-import-page-planner.ts";
import type {
  ClaimedProviderImportRun,
  ProviderImportPagePlanner,
  ProviderImportPageRepository,
  ProviderImportQueueExecutionResult,
  ProviderImportRunRepository,
  ProviderImportRunSummary,
  ProviderImportRuntimeRevision,
  ProviderImportRuntimeRevisionRepository,
  ProviderImportServiceErrorCode,
  ProviderImportTerminalFailureCode,
} from "./provider-import-types.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_TRANSIENT_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_RETRY_MAX_MS = 2_000;
const DEFAULT_LEASE_DURATION_MS = 120_000;
const DEFAULT_MAX_PAGES = 10_000;
const DEFAULT_MAX_RUN_DURATION_MS = 15 * 60_000;

export interface ProviderImportSleeper {
  sleep(milliseconds: number): Promise<void>;
}

export interface ProviderImportRandom {
  value(): number;
}

export interface ProviderImportServiceDependencies {
  readonly runs: ProviderImportRunRepository;
  readonly revisions: ProviderImportRuntimeRevisionRepository;
  readonly pages: ProviderImportPageRepository;
  readonly transportAdapters: ProviderTransportAdapterRegistry;
  readonly pagePlanner: ProviderImportPagePlanner;
  readonly credentialCipher: ProviderCredentialCipher;
  readonly actorKeyer: ProviderActorKeyer;
  readonly clock: ProviderClock;
  readonly ids: ProviderIdSource;
  readonly environment: ProviderRuntimeEnvironment;
  readonly sleeper?: ProviderImportSleeper;
  readonly random?: ProviderImportRandom;
  readonly requestTimeoutMs?: number;
  readonly maximumResponseBytes?: number;
  readonly maximumTransientRetries?: number;
  readonly retryBaseMs?: number;
  readonly retryMaximumMs?: number;
  readonly leaseDurationMs?: number;
  readonly maximumPages?: number;
  readonly maximumRunDurationMs?: number;
}

export type ProviderImportRequest =
  | {
      readonly trigger: "manual";
      readonly providerId: string;
      readonly actor: ProviderActor;
      readonly expectedConfigurationRevisionId: string;
    }
  | {
      readonly trigger: "scheduled" | "continuation";
      readonly providerId: string;
      readonly organizationId: string;
    };

export interface ProviderImportRequestResult {
  readonly run: ProviderImportRunSummary;
  readonly coalesced: boolean;
}

export class ProviderImportServiceError extends Error {
  constructor(
    readonly code: ProviderImportServiceErrorCode,
    message: string,
    readonly status: number,
    readonly activeRun?: ProviderImportRunSummary,
  ) {
    super(message);
    this.name = "ProviderImportServiceError";
  }
}

interface ImportFailure {
  readonly code: ProviderImportTerminalFailureCode;
  readonly summary: string;
}

const defaultSleeper: ProviderImportSleeper = {
  sleep: (milliseconds) =>
    new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    }),
};

const defaultRandom: ProviderImportRandom = { value: Math.random };

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new RangeError(`${label} is outside its safe bounds.`);
  }
  return resolved;
}

function organizationIdForRequest(input: ProviderImportRequest): string {
  return input.trigger === "manual"
    ? input.actor.organizationId
    : input.organizationId;
}

function terminalFailureForTransport(
  failure: NormalizedProviderTransportFailure,
): ImportFailure {
  if (
    failure.code === "http_error" &&
    (failure.httpStatus === 401 || failure.httpStatus === 403)
  ) {
    return {
      code: "IMPORT_AUTHENTICATION_FAILED",
      summary: "Provider authentication failed.",
    };
  }
  if (failure.code === "http_error" && failure.httpStatus === 429) {
    return {
      code: "IMPORT_RATE_LIMITED",
      summary: "Provider rate limiting prevented the import from continuing.",
    };
  }
  if (
    failure.code === "invalid_response" &&
    failure.issueCodes?.some((code) =>
      ["cursor_cycle", "cursor_not_advanced", "empty_continuing_page"].includes(code),
    )
  ) {
    return {
      code: "IMPORT_CURSOR_SAFETY_FAILED",
      summary: "Provider pagination failed a cursor safety check.",
    };
  }
  const failures: Readonly<
    Record<NormalizedProviderTransportFailure["code"], ImportFailure>
  > = {
    destination_not_allowed: {
      code: "IMPORT_DESTINATION_REJECTED",
      summary: "Provider destination policy rejected the request.",
    },
    destination_resolution_failed: {
      code: "IMPORT_UNREACHABLE",
      summary: "Provider destination could not be reached.",
    },
    http_error: {
      code: "IMPORT_HTTP_ERROR",
      summary: "Provider returned an unsuccessful response.",
    },
    invalid_configuration: {
      code: "IMPORT_CONFIGURATION_UNAVAILABLE",
      summary: "Provider runtime configuration is unavailable.",
    },
    invalid_json: {
      code: "IMPORT_INVALID_JSON",
      summary: "Provider response was not valid JSON.",
    },
    invalid_response: {
      code: "IMPORT_INVALID_CONTRACT",
      summary: "Provider response failed the feed contract.",
    },
    network_error: {
      code: "IMPORT_UNREACHABLE",
      summary: "Provider request could not be completed.",
    },
    response_too_large: {
      code: "IMPORT_RESPONSE_TOO_LARGE",
      summary: "Provider response exceeded the allowed size.",
    },
    timeout: {
      code: "IMPORT_TIMEOUT",
      summary: "Provider request timed out.",
    },
  };
  return failures[failure.code];
}

function isOwnershipError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "RUN_OWNERSHIP_LOST"
  );
}

export class ProviderImportService {
  readonly #sleeper: ProviderImportSleeper;
  readonly #random: ProviderImportRandom;
  readonly #requestTimeoutMs: number;
  readonly #maximumResponseBytes: number;
  readonly #maximumTransientRetries: number;
  readonly #retryBaseMs: number;
  readonly #retryMaximumMs: number;
  readonly #leaseDurationMs: number;
  readonly #maximumPages: number;
  readonly #maximumRunDurationMs: number;

  constructor(private readonly dependencies: ProviderImportServiceDependencies) {
    this.#sleeper = dependencies.sleeper ?? defaultSleeper;
    this.#random = dependencies.random ?? defaultRandom;
    this.#requestTimeoutMs = boundedInteger(
      dependencies.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      1,
      60_000,
      "Provider request timeout",
    );
    this.#maximumResponseBytes = boundedInteger(
      dependencies.maximumResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      1,
      10 * 1024 * 1024,
      "Provider response limit",
    );
    this.#maximumTransientRetries = boundedInteger(
      dependencies.maximumTransientRetries,
      DEFAULT_MAX_TRANSIENT_RETRIES,
      0,
      5,
      "Provider retry count",
    );
    this.#retryBaseMs = boundedInteger(
      dependencies.retryBaseMs,
      DEFAULT_RETRY_BASE_MS,
      1,
      10_000,
      "Provider retry base",
    );
    this.#retryMaximumMs = boundedInteger(
      dependencies.retryMaximumMs,
      DEFAULT_RETRY_MAX_MS,
      this.#retryBaseMs,
      60_000,
      "Provider retry maximum",
    );
    this.#leaseDurationMs = boundedInteger(
      dependencies.leaseDurationMs,
      DEFAULT_LEASE_DURATION_MS,
      this.#requestTimeoutMs + this.#retryMaximumMs,
      15 * 60_000,
      "Import lease duration",
    );
    this.#maximumPages = boundedInteger(
      dependencies.maximumPages,
      DEFAULT_MAX_PAGES,
      1,
      100_000,
      "Import page limit",
    );
    this.#maximumRunDurationMs = boundedInteger(
      dependencies.maximumRunDurationMs,
      DEFAULT_MAX_RUN_DURATION_MS,
      this.#leaseDurationMs,
      24 * 60 * 60_000,
      "Import run duration",
    );
  }

  async requestImport(
    input: ProviderImportRequest,
  ): Promise<ProviderImportRequestResult> {
    const organizationId = organizationIdForRequest(input);
    const requestedByActorKey =
      input.trigger === "manual"
        ? this.dependencies.actorKeyer.keyFor({
            organizationId,
            operatorId: input.actor.operatorId,
          })
        : null;
    const result = await this.dependencies.runs.requestRun({
      organizationId,
      providerId: input.providerId,
      runId: this.dependencies.ids.id(),
      trigger: input.trigger,
      requestedByActorKey,
      requestedAt: this.dependencies.clock.now(),
      ...(input.trigger === "manual"
        ? {
            expectedConfigurationRevisionId:
              input.expectedConfigurationRevisionId,
          }
        : {}),
    });
    if (result.kind === "created") {
      return { run: result.run, coalesced: false };
    }
    if (result.kind === "active") {
      return { run: result.run, coalesced: true };
    }
    if (result.kind === "revision_conflict") {
      throw new ProviderImportServiceError(
        "CONFIG_REVISION_CONFLICT",
        "The active provider configuration changed. Refresh and try again.",
        409,
      );
    }
    if (result.kind === "not_found") {
      throw new ProviderImportServiceError(
        "PROVIDER_NOT_FOUND",
        "Provider not found.",
        404,
      );
    }
    throw new ProviderImportServiceError(
      "PROVIDER_NOT_IMPORTABLE",
      "Provider is not enabled for import.",
      409,
    );
  }

  async executeImport(input: {
    organizationId: string;
    runId: string;
    workerId: string;
  }): Promise<ProviderImportRunSummary> {
    const claimedAt = this.dependencies.clock.now();
    const claim = await this.dependencies.runs.claimRun({
      ...input,
      claimedAt,
      leaseExpiresAt: this.leaseExpiresAt(claimedAt),
    });
    if (claim.kind === "not_found") {
      throw new ProviderImportServiceError(
        "IMPORT_RUN_NOT_FOUND",
        "Import run not found.",
        404,
      );
    }
    if (claim.kind === "not_claimable") {
      throw new ProviderImportServiceError(
        "IMPORT_RUN_NOT_CLAIMABLE",
        "Import run cannot be claimed.",
        409,
        claim.run,
      );
    }
    return this.executeClaimedRun(claim.run, claimedAt);
  }

  async executeNextImport(input: {
    workerId: string;
  }): Promise<ProviderImportQueueExecutionResult> {
    const claimedAt = this.dependencies.clock.now();
    const claim = await this.dependencies.runs.claimNextRun({
      workerId: input.workerId,
      claimedAt,
      leaseExpiresAt: this.leaseExpiresAt(claimedAt),
    });
    if (claim.kind === "idle") return claim;
    return {
      kind: "executed",
      run: await this.executeClaimedRun(claim.run, claimedAt),
    };
  }

  private async executeClaimedRun(
    run: ClaimedProviderImportRun,
    claimedAt: Date,
  ): Promise<ProviderImportRunSummary> {
    const revision = await this.dependencies.revisions.getImmutableRevisionForRuntime({
      organizationId: run.organizationId,
      providerId: run.providerId,
      revisionId: run.configRevisionId,
    });
    if (!revision) {
      return this.finishFailure(run, {
        code: "IMPORT_CONFIGURATION_UNAVAILABLE",
        summary: "Provider runtime configuration is unavailable.",
      });
    }

    let adapter: ProviderTransportAdapter;
    let endpoint: ReturnType<typeof validateProviderEndpoint>;
    let auth: ProviderAuth;
    try {
      adapter = this.dependencies.transportAdapters.resolve(
        revision.adapterKey,
        revision.platformKey,
      );
      endpoint = validateProviderEndpoint(
        revision.endpoint,
        this.dependencies.environment,
      );
      auth = this.authForRevision(revision);
    } catch (error) {
      const failure: ImportFailure =
        error instanceof ProviderEndpointPolicyError
          ? {
              code: "IMPORT_DESTINATION_REJECTED",
              summary: "Provider destination policy rejected the request.",
            }
          : {
              code: "IMPORT_CONFIGURATION_UNAVAILABLE",
              summary: "Provider runtime configuration is unavailable.",
            };
      return this.finishFailure(run, failure);
    }

    let cursor = run.currentCursor;
    let pageNumber = run.nextPageNumber;
    const seenCursors = new Set<string>();
    if (cursor !== null) seenCursors.add(cursor);
    while (true) {
      if (
        pageNumber > this.#maximumPages ||
        this.dependencies.clock.now().getTime() - claimedAt.getTime() >
          this.#maximumRunDurationMs
      ) {
        return this.finishFailure(run, {
          code: "IMPORT_RUN_LIMIT_REACHED",
          summary: "Import stopped at a configured safety limit.",
        });
      }
      await this.requireLease(run);
      const fetched = await this.fetchWithRetries({
        run,
        revision,
        adapter,
        endpoint: endpoint.endpoint,
        allowedHosts: endpoint.allowedHosts,
        auth,
        cursor,
        seenCursors,
      });
      if ("failure" in fetched) return this.finishFailure(run, fetched.failure);
      let planned;
      try {
        planned = await this.dependencies.pagePlanner.plan({
          configuration: {
            providerId: run.providerId,
            configurationRevisionId: run.configRevisionId,
            platform: revision.platformKey,
            adapterKey: revision.adapterKey,
          },
          page: fetched.page,
        });
      } catch (error) {
        const failure: ImportFailure = {
          code: "IMPORT_MAPPING_FAILED",
          summary:
            error instanceof ProviderImportPlanningError ||
            error instanceof ProviderAdapterRegistryError
              ? error.message
              : "Provider mapping could not safely process the page.",
        };
        return this.finishFailure(run, failure);
      }
      await this.requireLease(run);
      let committed;
      try {
        committed = await this.dependencies.pages.commitPage({
          organizationId: run.organizationId,
          providerId: run.providerId,
          configRevisionId: run.configRevisionId,
          runId: run.id,
          workerId: run.workerId,
          pageNumber,
          requestedCursor: cursor,
          nextCursor: fetched.page.rawPage.next_cursor,
          hasMore: fetched.page.rawPage.has_more,
          payload: fetched.page.rawPage,
          records: planned.records,
          quarantines: planned.quarantines,
          committedAt: this.dependencies.clock.now(),
        });
      } catch (error) {
        if (isOwnershipError(error)) this.throwOwnershipLost();
        return this.finishFailure(run, {
          code: "IMPORT_PERSISTENCE_FAILED",
          summary: "Provider page could not be durably committed.",
        });
      }
      const nextCursor = fetched.page.rawPage.next_cursor;
      cursor = nextCursor;
      if (!fetched.page.rawPage.has_more) {
        return this.finishSuccess(
          run,
          committed.counters.quarantined > 0 ? "incomplete" : "succeeded",
        );
      }
      seenCursors.add(nextCursor);
      pageNumber += 1;
    }
  }

  private async fetchWithRetries(input: {
    run: ClaimedProviderImportRun;
    revision: ProviderImportRuntimeRevision;
    adapter: ProviderTransportAdapter;
    endpoint: string;
    allowedHosts: readonly string[];
    auth: ProviderAuth;
    cursor: string | null;
    seenCursors: ReadonlySet<string>;
  }): Promise<
    | { readonly page: Awaited<ReturnType<ProviderTransportAdapter["fetchPage"]>> }
    | { readonly failure: ImportFailure }
  > {
    let lastFailure: NormalizedProviderTransportFailure | null = null;
    for (let attempt = 0; attempt <= this.#maximumTransientRetries; attempt += 1) {
      const counted = await this.dependencies.runs.recordRequestAttempt({
        organizationId: input.run.organizationId,
        runId: input.run.id,
        workerId: input.run.workerId,
        transientRetry: attempt > 0,
      });
      if (!counted) this.throwOwnershipLost();
      try {
        const page = await input.adapter.fetchPage({
          endpoint: input.endpoint,
          allowedHosts: input.allowedHosts,
          platform: input.revision.platformKey,
          cursor: input.cursor,
          auth: input.auth,
          timeoutMs: this.#requestTimeoutMs,
          maxResponseBytes: this.#maximumResponseBytes,
          seenCursors: input.seenCursors,
          allowLocalHttp: this.dependencies.environment === "local",
        });
        return { page };
      } catch (error) {
        lastFailure =
          error instanceof ProviderTransportRequestError
            ? error.failure
            : { code: "network_error", retryable: true };
        if (!lastFailure.retryable || attempt === this.#maximumTransientRetries) {
          return { failure: terminalFailureForTransport(lastFailure) };
        }
        const exponential = Math.min(
          this.#retryMaximumMs,
          this.#retryBaseMs * 2 ** attempt,
        );
        const random = Math.min(1, Math.max(0, this.#random.value()));
        await this.#sleeper.sleep(Math.max(1, Math.round(exponential * (0.5 + random * 0.5))));
        await this.requireLease(input.run);
      }
    }
    return {
      failure: lastFailure
        ? terminalFailureForTransport(lastFailure)
        : {
            code: "IMPORT_RETRY_EXHAUSTED",
            summary: "Provider request retries were exhausted.",
          },
    };
  }

  private authForRevision(revision: ProviderImportRuntimeRevision): ProviderAuth {
    if (revision.authMode === "none") return { mode: "none" };
    if (!revision.encryptedCredential) throw new Error("Credential unavailable.");
    return {
      mode: "bearer",
      token: this.dependencies.credentialCipher.decrypt(
        revision.encryptedCredential,
        {
          organizationId: revision.organizationId,
          providerId: revision.providerId,
          revisionId: revision.revisionId,
        },
      ),
    };
  }

  private async requireLease(run: ClaimedProviderImportRun): Promise<void> {
    const now = this.dependencies.clock.now();
    const renewed = await this.dependencies.runs.renewLease({
      organizationId: run.organizationId,
      runId: run.id,
      workerId: run.workerId,
      renewedAt: now,
      leaseExpiresAt: this.leaseExpiresAt(now),
    });
    if (!renewed) this.throwOwnershipLost();
  }

  private leaseExpiresAt(now: Date): Date {
    return new Date(now.getTime() + this.#leaseDurationMs);
  }

  private async finishSuccess(
    run: ClaimedProviderImportRun,
    state: "succeeded" | "incomplete",
  ): Promise<ProviderImportRunSummary> {
    return this.finish(run, state, true, null);
  }

  private async finishFailure(
    run: ClaimedProviderImportRun,
    failure: ImportFailure,
  ): Promise<ProviderImportRunSummary> {
    return this.finish(run, "failed", false, failure);
  }

  private async finish(
    run: ClaimedProviderImportRun,
    state: "succeeded" | "incomplete" | "failed",
    reachedProviderHead: boolean,
    failure: ImportFailure | null,
  ): Promise<ProviderImportRunSummary> {
    const result = await this.dependencies.runs.finishRun({
      organizationId: run.organizationId,
      runId: run.id,
      workerId: run.workerId,
      state,
      reachedProviderHead,
      failureCode: failure?.code ?? null,
      failureSummary: failure?.summary ?? null,
      finishedAt: this.dependencies.clock.now(),
    });
    if (result.kind === "finished" || result.kind === "already_terminal") {
      return result.run;
    }
    if (result.kind === "not_found") {
      throw new ProviderImportServiceError(
        "IMPORT_RUN_NOT_FOUND",
        "Import run not found.",
        404,
      );
    }
    return this.throwOwnershipLost();
  }

  private throwOwnershipLost(): never {
    throw new ProviderImportServiceError(
      "RUN_OWNERSHIP_LOST",
      "Import run ownership was lost.",
      409,
    );
  }
}
