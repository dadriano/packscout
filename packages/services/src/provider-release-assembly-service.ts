import type {
  PinnedProviderReleaseInputs,
  ProviderReleaseAssemblyResult,
} from "@packscout/database";

export interface ProviderReleaseCentralPinPort {
  pin(input: {
    readonly providerId: string;
    readonly catalogVersionId?: string;
  }): Promise<PinnedProviderReleaseInputs>;
}

export interface ProviderReleaseStorePort {
  assemble(input: {
    readonly workerId: string;
    readonly leaseMilliseconds: number;
    readonly pin: PinnedProviderReleaseInputs;
  }): Promise<ProviderReleaseAssemblyResult>;
}

export interface ProviderReleaseAssemblyDiagnostic {
  readonly providerId: string;
  readonly providerKey: string | null;
  readonly claimedSequence: string | null;
  readonly catalogVersionId: string | null;
  readonly stage: "central_pin" | "provider_snapshot";
  readonly failureCode: string;
  readonly retryable: boolean;
}

export type ProviderReleaseServiceResult =
  | {
      readonly status: "assembled";
      readonly assembly: ProviderReleaseAssemblyResult;
    }
  | {
      readonly status: "failed";
      readonly diagnostic: ProviderReleaseAssemblyDiagnostic;
    };

function boundedFailureCode(error: unknown): string {
  if (
    error !== null
    && typeof error === "object"
    && "code" in error
    && typeof error.code === "string"
    && /^[A-Z][A-Z0-9_]{0,79}$/u.test(error.code)
  ) return error.code;
  return "PROVIDER_RELEASE_ASSEMBLY_FAILED";
}

function claimedSequence(error: unknown): string | null {
  if (
    error !== null
    && typeof error === "object"
    && "selectedThroughChangeSequence" in error
    && typeof error.selectedThroughChangeSequence === "bigint"
  ) return error.selectedThroughChangeSequence.toString();
  return null;
}

function retryable(code: string): boolean {
  return [
    "PROVIDER_RELEASE_LEASE_HELD",
    "PROVIDER_RELEASE_FENCE_STALE",
    "CATALOG_VERSION_MISSING",
    "CATALOG_VERSION_INCOMPLETE",
    "CORRELATION_MISSING",
    "CORRELATION_STALE",
  ].includes(code);
}

export class ProviderReleaseAssemblyService {
  constructor(private readonly dependencies: {
    readonly workerId: string;
    readonly leaseMilliseconds: number;
    readonly central: ProviderReleaseCentralPinPort;
    readonly providerFor: (input: {
      readonly providerId: string;
      readonly providerKey: string;
    }) => Promise<ProviderReleaseStorePort>;
  }) {}

  async assemble(input: {
    readonly providerId: string;
    readonly catalogVersionId?: string;
  }): Promise<ProviderReleaseServiceResult> {
    let pin: PinnedProviderReleaseInputs;
    try {
      pin = await this.dependencies.central.pin(input);
    } catch (error) {
      const failureCode = boundedFailureCode(error);
      return {
        status: "failed",
        diagnostic: {
          providerId: input.providerId,
          providerKey: null,
          claimedSequence: null,
          catalogVersionId: input.catalogVersionId ?? null,
          stage: "central_pin",
          failureCode,
          retryable: retryable(failureCode),
        },
      };
    }
    try {
      const provider = await this.dependencies.providerFor({
        providerId: pin.providerId,
        providerKey: pin.providerKey,
      });
      return {
        status: "assembled",
        assembly: await provider.assemble({
          workerId: this.dependencies.workerId,
          leaseMilliseconds: this.dependencies.leaseMilliseconds,
          pin,
        }),
      };
    } catch (error) {
      const failureCode = boundedFailureCode(error);
      return {
        status: "failed",
        diagnostic: {
          providerId: pin.providerId,
          providerKey: pin.providerKey,
          claimedSequence: claimedSequence(error),
          catalogVersionId: pin.catalogVersionId,
          stage: "provider_snapshot",
          failureCode,
          retryable: retryable(failureCode),
        },
      };
    }
  }
}
