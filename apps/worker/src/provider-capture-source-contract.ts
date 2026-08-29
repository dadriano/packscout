import type {
  CanonicalJsonObject,
  ProviderMixedPageRecordKind,
} from "@packscout/database";

export const CLUTCHPACKS_CAPTURE_ADAPTER_KEY =
  "local-capture-clutchpacks-v1" as const;
export const CLUTCHPACKS_CAPTURE_FILE_NAME = "clutchpacks.json" as const;
export const CLUTCHPACKS_CAPTURE_SHA256 =
  "6f7f76a26e21233e62f07e56b58b45ab9b17ce083e1db915704c5237d1b76fba" as const;
export const PROVIDER_CAPTURE_MAXIMUM_BYTES = 2 * 1_048_576;

export type ProviderCaptureSourceFailureCode =
  | "PROVIDER_CAPTURE_ABORTED"
  | "PROVIDER_CAPTURE_CONFIGURATION_INVALID"
  | "PROVIDER_CAPTURE_FILE_INVALID"
  | "PROVIDER_CAPTURE_FILE_UNAVAILABLE"
  | "PROVIDER_CAPTURE_HASH_MISMATCH"
  | "PROVIDER_CAPTURE_RECORD_INVALID"
  | "PROVIDER_CAPTURE_ROOT_INVALID"
  | "PROVIDER_CAPTURE_SOURCE_CHECKPOINT_INVALID"
  | "PROVIDER_SOURCE_ADAPTER_UNAVAILABLE";

/**
 * Public-safe source failure. It deliberately carries neither a filesystem
 * path nor provider-native evidence.
 */
export class ProviderCaptureSourceError extends Error {
  constructor(readonly code: ProviderCaptureSourceFailureCode) {
    super(code);
    this.name = "ProviderCaptureSourceError";
  }
}

export interface ProviderCaptureAuthority {
  readonly providerId: string;
  readonly providerKey: string;
  readonly configVersionId: string;
  readonly configVersionNumber: bigint;
  readonly configuration: Readonly<Record<string, unknown>>;
}

export interface ProviderCapturePageSourceInput {
  readonly authority: ProviderCaptureAuthority;
  readonly runId: string;
  readonly workerFence: bigint;
  readonly sourceCheckpointFingerprint: string | null;
  readonly signal: AbortSignal;
}

export interface ProviderMixedPageRecordDraft {
  readonly kind: ProviderMixedPageRecordKind;
  readonly operation?: "upsert" | "retire";
  readonly entityType?:
    | "category"
    | "pack"
    | "collectible"
    | "collectible_name_alias"
    | "collectible_instance"
    | "pack_content"
    | "provider_account";
  readonly candidate: CanonicalJsonObject;
}

export interface ProviderCaptureTranslationCounts {
  readonly categories: number;
  readonly packs: number;
  readonly collectibles: number;
  readonly providerAccounts: number;
  readonly pulls: number;
  readonly pullsWithoutPackKey: number;
  readonly marketEvents: number;
  readonly packContents: number;
}

export interface ProviderCaptureTranslation {
  readonly records: readonly ProviderMixedPageRecordDraft[];
  readonly counts: ProviderCaptureTranslationCounts;
}
