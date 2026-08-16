import {
  MAX_APPROVED_PUBLIC_PLATFORMS,
  providerPlatformKeySchema,
} from "@packscout/contracts";
import { resolvePackScoutPublicOrganizationId } from "./public-change-settlement-service.ts";

export { MAX_APPROVED_PUBLIC_PLATFORMS };

const configurationKeyPattern =
  /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;

export interface SharedPublicConfigurationEpoch {
  readonly configurationKey: string;
  readonly revision: number;
  readonly publicChangeSequence: bigint;
  readonly configurationHash: string;
}

export type ProviderCatalogBlockedState =
  | Readonly<{ kind: "ready" }>
  | Readonly<{
      kind: "blocked";
      reason: "pending_derivation" | "technical_failure";
      causeSequence: bigint;
    }>;

export interface ProviderCatalogCheckpoint {
  readonly organizationId: string;
  readonly platformKey: string;
  readonly sharedConfigurationEpoch: SharedPublicConfigurationEpoch;
  readonly settledSequence: bigint;
  readonly sourceHeadSequence: bigint;
  readonly settledAt: Date;
  readonly sourceHeadAt: Date;
  readonly blockedState: ProviderCatalogBlockedState;
}

export interface ManifestEligibilitySnapshot {
  readonly organizationId: string;
  readonly sharedConfigurationEpoch: SharedPublicConfigurationEpoch;
  readonly enabledPlatformKeys: readonly string[];
  readonly lifecycleDecisionSequence: bigint;
  readonly checkpoints: readonly ProviderCatalogCheckpoint[];
}

export interface ProviderCatalogCheckpointReadPort {
  loadProviderCatalogCheckpoint(input: Readonly<{
    organizationId: string;
    platformKey: string;
  }>): Promise<unknown | null>;
}

export interface ManifestEligibilityReadPort {
  /** The repository must read configuration, lifecycle, and checkpoints atomically. */
  loadManifestEligibilitySnapshot(input: Readonly<{
    organizationId: string;
  }>): Promise<unknown | null>;
}

export interface ProviderCatalogSettlementReadPort
  extends ProviderCatalogCheckpointReadPort, ManifestEligibilityReadPort {}

export type ProviderCatalogSettlementErrorCode =
  | "PROVIDER_CATALOG_CONFIGURATION_INVALID"
  | "PROVIDER_CATALOG_CHECKPOINT_UNAVAILABLE"
  | "PROVIDER_CATALOG_CHECKPOINT_INVALID"
  | "MANIFEST_ELIGIBILITY_UNAVAILABLE"
  | "MANIFEST_ELIGIBILITY_INVALID"
  | "MANIFEST_ENABLED_PLATFORM_LIMIT_EXCEEDED";

export class ProviderCatalogSettlementError extends Error {
  constructor(readonly code: ProviderCatalogSettlementErrorCode) {
    super("Provider catalog settlement state is unavailable or invalid.");
    this.name = "ProviderCatalogSettlementError";
  }
}

function refuse(code: ProviderCatalogSettlementErrorCode): never {
  throw new ProviderCatalogSettlementError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

function canonicalPlatformKey(
  value: unknown,
  code: ProviderCatalogSettlementErrorCode,
): string {
  if (typeof value !== "string") refuse(code);
  const parsed = providerPlatformKeySchema.safeParse(value);
  if (!parsed.success || parsed.data !== value) refuse(code);
  return parsed.data;
}

function positiveSafeInteger(
  value: unknown,
  code: ProviderCatalogSettlementErrorCode,
): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) refuse(code);
  return value as number;
}

function nonNegativeSequence(
  value: unknown,
  code: ProviderCatalogSettlementErrorCode,
): bigint {
  if (typeof value !== "bigint" || value < 0n) refuse(code);
  return value;
}

function positiveSequence(
  value: unknown,
  code: ProviderCatalogSettlementErrorCode,
): bigint {
  const sequence = nonNegativeSequence(value, code);
  if (sequence === 0n) refuse(code);
  return sequence;
}

function finiteDate(
  value: unknown,
  code: ProviderCatalogSettlementErrorCode,
): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) refuse(code);
  return new Date(value.getTime());
}

function epoch(
  value: unknown,
  code: ProviderCatalogSettlementErrorCode,
): SharedPublicConfigurationEpoch {
  if (!isRecord(value) || !hasExactKeys(value, [
    "configurationKey",
    "revision",
    "publicChangeSequence",
    "configurationHash",
  ])) refuse(code);
  if (
    typeof value.configurationKey !== "string" ||
    !configurationKeyPattern.test(value.configurationKey) ||
    typeof value.configurationHash !== "string" ||
    !sha256Pattern.test(value.configurationHash)
  ) refuse(code);
  return Object.freeze({
    configurationKey: value.configurationKey,
    revision: positiveSafeInteger(value.revision, code),
    publicChangeSequence: positiveSequence(value.publicChangeSequence, code),
    configurationHash: value.configurationHash,
  });
}

function blockedState(
  value: unknown,
  input: Readonly<{ settledSequence: bigint; sourceHeadSequence: bigint }>,
  code: ProviderCatalogSettlementErrorCode,
): ProviderCatalogBlockedState {
  if (!isRecord(value) || typeof value.kind !== "string") refuse(code);
  if (value.kind === "ready") {
    if (!hasExactKeys(value, ["kind"]) ||
        input.settledSequence !== input.sourceHeadSequence) {
      refuse(code);
    }
    return Object.freeze({ kind: "ready" });
  }
  if (!hasExactKeys(value, ["kind", "reason", "causeSequence"]) ||
      value.kind !== "blocked" ||
      (value.reason !== "pending_derivation" &&
        value.reason !== "technical_failure")) {
    refuse(code);
  }
  const causeSequence = positiveSequence(value.causeSequence, code);
  if (
    input.settledSequence >= input.sourceHeadSequence ||
    causeSequence <= input.settledSequence ||
    causeSequence > input.sourceHeadSequence
  ) refuse(code);
  return Object.freeze({
    kind: "blocked",
    reason: value.reason,
    causeSequence,
  });
}

function checkpoint(
  value: unknown,
  expectedOrganizationId: string,
  code: ProviderCatalogSettlementErrorCode,
): ProviderCatalogCheckpoint {
  if (!isRecord(value) || !hasExactKeys(value, [
    "organizationId",
    "platformKey",
    "sharedConfigurationEpoch",
    "settledSequence",
    "sourceHeadSequence",
    "settledAt",
    "sourceHeadAt",
    "blockedState",
  ])) refuse(code);
  if (value.organizationId !== expectedOrganizationId) refuse(code);
  const settledSequence = nonNegativeSequence(value.settledSequence, code);
  const sourceHeadSequence = nonNegativeSequence(value.sourceHeadSequence, code);
  const sharedConfigurationEpoch = epoch(
    value.sharedConfigurationEpoch,
    code,
  );
  if (
    settledSequence > sourceHeadSequence ||
    sharedConfigurationEpoch.publicChangeSequence > sourceHeadSequence
  ) refuse(code);
  return Object.freeze({
    organizationId: expectedOrganizationId,
    platformKey: canonicalPlatformKey(value.platformKey, code),
    sharedConfigurationEpoch,
    settledSequence,
    sourceHeadSequence,
    settledAt: finiteDate(value.settledAt, code),
    sourceHeadAt: finiteDate(value.sourceHeadAt, code),
    blockedState: blockedState(value.blockedState, {
      settledSequence,
      sourceHeadSequence,
    }, code),
  });
}

function enabledPlatformKeys(value: unknown): readonly string[] {
  if (!Array.isArray(value)) refuse("MANIFEST_ELIGIBILITY_INVALID");
  if (value.length > MAX_APPROVED_PUBLIC_PLATFORMS) {
    refuse("MANIFEST_ENABLED_PLATFORM_LIMIT_EXCEEDED");
  }
  const keys = value.map((candidate) =>
    canonicalPlatformKey(candidate, "MANIFEST_ELIGIBILITY_INVALID"));
  if (keys.some((key, index) => index > 0 && keys[index - 1]! >= key)) {
    refuse("MANIFEST_ELIGIBILITY_INVALID");
  }
  return Object.freeze(keys);
}

export function sameSharedPublicConfigurationEpoch(
  left: SharedPublicConfigurationEpoch,
  right: SharedPublicConfigurationEpoch,
): boolean {
  return left.configurationKey === right.configurationKey &&
    left.revision === right.revision &&
    left.publicChangeSequence === right.publicChangeSequence &&
    left.configurationHash === right.configurationHash;
}

function manifestSnapshot(
  value: unknown,
  expectedOrganizationId: string,
): ManifestEligibilitySnapshot {
  const code = "MANIFEST_ELIGIBILITY_INVALID" as const;
  if (!isRecord(value) || !hasExactKeys(value, [
    "organizationId",
    "sharedConfigurationEpoch",
    "enabledPlatformKeys",
    "lifecycleDecisionSequence",
    "checkpoints",
  ])) refuse(code);
  if (value.organizationId !== expectedOrganizationId ||
      !Array.isArray(value.checkpoints)) refuse(code);
  const sharedConfigurationEpoch = epoch(value.sharedConfigurationEpoch, code);
  const platformKeys = enabledPlatformKeys(value.enabledPlatformKeys);
  if (value.checkpoints.length !== platformKeys.length) refuse(code);
  const checkpoints = value.checkpoints.map((candidate) =>
    checkpoint(candidate, expectedOrganizationId, code));
  if (checkpoints.some((candidate, index) =>
    candidate.platformKey !== platformKeys[index] ||
    !sameSharedPublicConfigurationEpoch(
      candidate.sharedConfigurationEpoch,
      sharedConfigurationEpoch,
    ))) refuse(code);
  const lifecycleDecisionSequence = nonNegativeSequence(
    value.lifecycleDecisionSequence,
    code,
  );
  if (lifecycleDecisionSequence < sharedConfigurationEpoch.publicChangeSequence) {
    refuse(code);
  }
  return Object.freeze({
    organizationId: expectedOrganizationId,
    sharedConfigurationEpoch,
    enabledPlatformKeys: platformKeys,
    lifecycleDecisionSequence,
    checkpoints: Object.freeze(checkpoints),
  });
}

function boundPlatformKey(value: string): string {
  try {
    return canonicalPlatformKey(
      value,
      "PROVIDER_CATALOG_CONFIGURATION_INVALID",
    );
  } catch (error) {
    if (error instanceof ProviderCatalogSettlementError) throw error;
    return refuse("PROVIDER_CATALOG_CONFIGURATION_INVALID");
  }
}

function boundOrganizationId(value: string): string {
  try {
    return resolvePackScoutPublicOrganizationId(value);
  } catch {
    return refuse("PROVIDER_CATALOG_CONFIGURATION_INVALID");
  }
}

/** Binds organization and platform selection before any worker request runs. */
export class ProviderCatalogSettlementService {
  readonly #organizationId: string;
  readonly #platformKey: string;

  constructor(
    private readonly repository: ProviderCatalogCheckpointReadPort,
    configuration: Readonly<{ organizationId: string; platformKey: string }>,
  ) {
    this.#organizationId = boundOrganizationId(configuration.organizationId);
    this.#platformKey = boundPlatformKey(configuration.platformKey);
  }

  async getCheckpoint(): Promise<ProviderCatalogCheckpoint> {
    const candidate = await this.repository.loadProviderCatalogCheckpoint({
      organizationId: this.#organizationId,
      platformKey: this.#platformKey,
    });
    if (candidate === null) {
      refuse("PROVIDER_CATALOG_CHECKPOINT_UNAVAILABLE");
    }
    const validated = checkpoint(
      candidate,
      this.#organizationId,
      "PROVIDER_CATALOG_CHECKPOINT_INVALID",
    );
    if (validated.platformKey !== this.#platformKey) {
      refuse("PROVIDER_CATALOG_CHECKPOINT_INVALID");
    }
    return validated;
  }
}

/** Binds tenant selection and returns one atomic configuration/lifecycle view. */
export class ManifestEligibilityService {
  readonly #organizationId: string;

  constructor(
    private readonly repository: ManifestEligibilityReadPort,
    configuration: Readonly<{ organizationId: string }>,
  ) {
    this.#organizationId = boundOrganizationId(configuration.organizationId);
  }

  async getSnapshot(): Promise<ManifestEligibilitySnapshot> {
    const candidate = await this.repository.loadManifestEligibilitySnapshot({
      organizationId: this.#organizationId,
    });
    if (candidate === null) refuse("MANIFEST_ELIGIBILITY_UNAVAILABLE");
    return manifestSnapshot(candidate, this.#organizationId);
  }
}
