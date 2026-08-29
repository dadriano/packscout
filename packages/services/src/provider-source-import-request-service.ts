import type {
  ProviderActor,
  ProviderActorKeyer,
  ProviderClock,
  ProviderIdSource,
} from "./provider-configuration-service.ts";

export type ProviderSourceImportRequestPersistenceResult =
  | Readonly<{
      kind: "created" | "active";
      run: ProviderSourceImportRunSummary;
    }>
  | Readonly<{ kind: "not_found" | "source_unavailable" }>
  | Readonly<{
      kind: "revision_conflict";
      activeSourceRevisionId: string;
    }>;

export interface ProviderSourceImportRunSummary {
  readonly id: string;
  readonly organizationId: string;
  readonly providerId: string;
  readonly sourceInstanceId: string;
  readonly sourceRevisionId: string;
  readonly trigger: "scheduled" | "manual" | "continuation" | "recovery";
  readonly state: "queued" | "running" | "succeeded" | "incomplete" | "failed";
  readonly requestedCursorFingerprint: string | null;
  readonly createdAt: Date;
}
export interface ProviderSourceImportRunRequestRepository {
  requestRun(input: {
    readonly organizationId: string;
    readonly providerId: string;
    readonly runId: string;
    readonly trigger: "scheduled" | "manual" | "continuation" | "recovery";
    readonly requestedByActorKey: string | null;
    readonly requestedAt: Date;
    readonly expectedSourceRevisionId?: string;
  }): Promise<ProviderSourceImportRequestPersistenceResult>;
}

export type ProviderSourceImportRequestErrorCode =
  | "PROVIDER_NOT_FOUND"
  | "PROVIDER_SOURCE_ADAPTER_UNAVAILABLE"
  | "SOURCE_NOT_IMPORTABLE"
  | "SOURCE_REVISION_CONFLICT";

export class ProviderSourceImportRequestError extends Error {
  constructor(
    readonly code: ProviderSourceImportRequestErrorCode,
    readonly status: number,
  ) {
    super(
      code === "PROVIDER_NOT_FOUND"
        ? "Provider not found."
        : code === "PROVIDER_SOURCE_ADAPTER_UNAVAILABLE"
          ? "No source integration is installed for this provider."
        : code === "SOURCE_REVISION_CONFLICT"
          ? "The active provider source changed. Refresh and try again."
          : "Provider source is not enabled for import.",
    );
    this.name = "ProviderSourceImportRequestError";
  }
}

export class ProviderSourceImportRequestService {
  constructor(private readonly dependencies: Readonly<{
    runs: ProviderSourceImportRunRequestRepository;
    actorKeyer: ProviderActorKeyer;
    clock: ProviderClock;
    ids: ProviderIdSource;
  }>) {}

  async requestManual(input: Readonly<{
    actor: ProviderActor;
    providerId: string;
    expectedSourceRevisionId: string;
  }>): Promise<Readonly<{
    run: ProviderSourceImportRunSummary;
    coalesced: boolean;
  }>> {
    const result = await this.dependencies.runs.requestRun({
      organizationId: input.actor.organizationId,
      providerId: input.providerId,
      runId: this.dependencies.ids.id(),
      trigger: "manual",
      requestedByActorKey: this.dependencies.actorKeyer.keyFor({
        organizationId: input.actor.organizationId,
        operatorId: input.actor.operatorId,
      }),
      requestedAt: this.dependencies.clock.now(),
      expectedSourceRevisionId: input.expectedSourceRevisionId,
    });
    if (result.kind === "created" || result.kind === "active") {
      return { run: result.run, coalesced: result.kind === "active" };
    }
    if (result.kind === "revision_conflict") {
      throw new ProviderSourceImportRequestError(
        "SOURCE_REVISION_CONFLICT",
        409,
      );
    }
    if (result.kind === "not_found") {
      throw new ProviderSourceImportRequestError("PROVIDER_NOT_FOUND", 404);
    }
    throw new ProviderSourceImportRequestError("SOURCE_NOT_IMPORTABLE", 409);
  }
}
