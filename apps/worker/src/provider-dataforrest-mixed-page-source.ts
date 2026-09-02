import { createHash, randomUUID } from "node:crypto";
import {
  opaqueCursorEnvelopeSchema,
  type OpaqueCursorEnvelope,
  type SourceAdapterFailure,
  countProviderPageRecords,
  providerCatalogIdentityCensusSchema,
  type NormalizedProviderObservationPage,
  type ProviderCatalogIdentityCensus,
  type ProviderPageRecordCounts,
} from "@packscout/contracts";
import {
  PROVIDER_MIXED_PAGE_CONTRACT_VERSION,
  PROVIDER_MIXED_PAGE_MAX_BYTES,
  PROVIDER_MIXED_PAGE_MAX_RECORDS,
  providerMixedCursorFingerprint,
  providerMixedPageCanonicalBytes,
  providerMixedPageDigest,
  validateProviderMixedPage,
  type CanonicalJsonObject,
  type CanonicalJsonValue,
} from "@packscout/database";
import {
  ConnectionPermitCoordinator,
  DataforrestEventsSourceAdapter,
  SourceRequestLeaseAuthority,
  captureAndTerminalizeSourceAdapterRequest,
  completeSourceAdapterPageRead,
  completeSourceAdapterRequestFailure,
  createPageReadOperation,
  interpretSourceAdapterPage,
  providerCatalogIdentityChainDigest,
  providerCatalogIdentityCountMapDigest,
  providerCatalogIdentityMultisetDigest,
  providerCatalogSourceIdentityDigest,
  sourceAdapterInterpretationContextOf,
  type CapturedSourcePageV1,
  type SourceAdapter,
  type SourceAdapterRequestTerminalizer,
} from "@packscout/services";
import type { ProviderManualImportPageSource } from
  "./provider-manual-import-executor.ts";
import type {
  ProviderCaptureAuthority,
  ProviderCapturePageSourceInput,
  ProviderCaptureTranslation,
  ProviderMixedPageQuarantineRecordDraft,
} from "./provider-capture-source-contract.ts";
import type {
  DataforrestSourceAuthorityRequest,
  ResolvedDataforrestSourceAuthority,
} from "./dataforrest-source-authority-resolver.ts";
import type { ProviderDataforrestLiveIntegration } from
  "./provider-dataforrest-live-integration.ts";
import { translateProviderNormalizedObservations } from
  "./provider-normalized-mixed-page-translation.ts";

export type ProviderDataforrestSourceFailureCode =
  | `PROVIDER_DATAFORREST_${Uppercase<SourceAdapterFailure["code"]>}`
  | "PROVIDER_DATAFORREST_ABORTED"
  | "PROVIDER_DATAFORREST_AUTHORITY_INVALID"
  | "PROVIDER_DATAFORREST_AUTHORITY_UNAVAILABLE"
  | "PROVIDER_DATAFORREST_CURSOR_INVALID"
  | "PROVIDER_DATAFORREST_CATALOG_RESTART_UNSUPPORTED"
  | "PROVIDER_DATAFORREST_PAGE_INVALID"
  | "PROVIDER_DATAFORREST_RESPONSE_INVALID"
  | "PROVIDER_DATAFORREST_TERMINALIZATION_FAILED"
  | "PROVIDER_DATAFORREST_TRANSLATION_INVALID";

/** Public-safe live-source failure with no upstream evidence or credentials. */
export class ProviderDataforrestSourceError extends Error {
  constructor(readonly code: ProviderDataforrestSourceFailureCode) {
    super(code);
    this.name = "ProviderDataforrestSourceError";
  }
}

export interface DataforrestSourceAuthorityResolver {
  resolve(
    input: DataforrestSourceAuthorityRequest,
  ): Promise<ResolvedDataforrestSourceAuthority>;
}

export interface ProviderDataforrestPageTranslationRecorder {
  recordPageTranslation(input: Readonly<{
    runId: string;
    workerId: string;
    workerFence: bigint;
    requestAttemptId: string;
    pageAttemptId: string;
    pageNumber: number;
    sourceRecordCount: number;
    normalizedRecordCount: number;
    recordCounts: ProviderPageRecordCounts;
    catalogIdentityCensus: ProviderCatalogIdentityCensus | null;
  }>): Promise<Readonly<{
    kind: "recorded" | "lease_lost" | "run_not_running";
  }>>;
}

function failure(code: ProviderDataforrestSourceFailureCode): never {
  throw new ProviderDataforrestSourceError(code);
}

function adapterFailure(code: SourceAdapterFailure["code"]): never {
  return failure(`PROVIDER_DATAFORREST_${code.toUpperCase()}` as
    ProviderDataforrestSourceFailureCode);
}

function selectedAdapterKey(authority: ProviderCaptureAuthority): string {
  const value = authority.configuration.adapterKey;
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
  ) {
    failure("PROVIDER_DATAFORREST_AUTHORITY_INVALID");
  }
  return value;
}

function deterministicUuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function safeGeneration(value: bigint): number {
  if (value < 1n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    failure("PROVIDER_DATAFORREST_AUTHORITY_INVALID");
  }
  return Number(value);
}

function validateResolvedAuthority(
  input: ProviderCapturePageSourceInput,
  adapterKey: string,
  resolved: ResolvedDataforrestSourceAuthority,
  integration: ProviderDataforrestLiveIntegration,
): void {
  if (
    resolved.providerId !== input.authority.providerId
    || resolved.providerKey !== integration.providerKey
    || resolved.providerKey !== input.authority.providerKey
    || resolved.configVersionId !== input.authority.configVersionId
    || resolved.configVersionNumber !== input.authority.configVersionNumber
    || resolved.adapterKey !== adapterKey
    || resolved.adapterKey !== integration.manifest.adapterVersion
    || resolved.sourceTypeKey !== integration.manifest.sourceTypeKey
    || resolved.sourceAdapterVersion !== integration.manifest.adapterVersion
    || resolved.sourceCredentialVersionNumber < 1n
    || resolved.organizationId.trim().length === 0
    || resolved.sourceCredentialVersionId.trim().length === 0
  ) {
    failure("PROVIDER_DATAFORREST_AUTHORITY_INVALID");
  }
}

interface DataforrestOperationIdentity {
  readonly sourceInstanceId: string;
  readonly sourceRevisionId: string;
  readonly connectionProfileId: string;
  readonly connectionProfileRevisionId: string;
  readonly identityNamespaceKey: string;
}

interface CatalogIdentityCensusState {
  readonly runId: string;
  readonly pages: Map<number, Readonly<{
    responseDigest: string;
    requestedCheckpointFingerprint: string | null;
    nextCheckpointFingerprint: string;
    census: ProviderCatalogIdentityCensus;
  }>>;
  readonly identityCounts: Map<string, number>;
  rawCardObservationCount: number;
  rawPackObservationCount: number;
  distinctCardIdentityCount: number;
  distinctPackIdentityCount: number;
  identityChainDigest: string | null;
  reachedHead: boolean;
}

export interface ProviderCatalogIdentityCensusWorkSnapshot {
  readonly pageDigestObservationCount: number;
  readonly maximumPageDigestObservationCount: number;
  readonly finalDigestDistinctIdentityCount: number;
  readonly finalDigestComputationCount: number;
}

function isCatalogSource(
  resolved: ResolvedDataforrestSourceAuthority,
): boolean {
  return "stream" in resolved.sourceConfiguration
    && resolved.sourceConfiguration.stream === "catalog";
}

function catalogPageIdentityDigests(
  page: NormalizedProviderObservationPage,
): Readonly<{ cards: readonly string[]; packs: readonly string[] }> {
  const cards: string[] = [];
  const packs: string[] = [];
  for (const outcome of page.outcomes) {
    if (outcome.status !== "valid") continue;
    const observation = outcome.observation;
    if (observation.kind !== "catalog") {
      failure("PROVIDER_DATAFORREST_TRANSLATION_INVALID");
    }
    const recordIdScopeKey = observation.entity === "card"
      ? "catalog-card-v1" as const
      : "catalog-pack-v1" as const;
    if (observation.providerRecordIdentity.recordIdScopeKey !== recordIdScopeKey) {
      failure("PROVIDER_DATAFORREST_TRANSLATION_INVALID");
    }
    const digest = providerCatalogSourceIdentityDigest({ recordIdScopeKey,
      providerRecordId: observation.providerRecordIdentity.providerRecordId });
    if (observation.entity === "card") cards.push(digest);
    else packs.push(digest);
  }
  return Object.freeze({ cards: Object.freeze(cards), packs: Object.freeze(packs) });
}

function safeIdentityCount(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    failure("PROVIDER_DATAFORREST_TRANSLATION_INVALID");
  }
  return sum;
}

/** One process-scoped catalog census. A restarted page-K run is deliberately terminal. */
export class ProviderCatalogIdentityCensusSession {
  #state: CatalogIdentityCensusState | null = null;
  #pageDigestObservationCount = 0;
  #maximumPageDigestObservationCount = 0;
  #finalDigestDistinctIdentityCount = 0;
  #finalDigestComputationCount = 0;

  assertCanRequest(input: Readonly<{
    runId: string;
    pageNumber: number;
    sourceCheckpoint: CanonicalJsonValue | null;
    sourceCheckpointFingerprint: string | null;
  }>): void {
    if (input.pageNumber === 1) {
      if (input.sourceCheckpoint !== null ||
        input.sourceCheckpointFingerprint !== null) {
        failure("PROVIDER_DATAFORREST_CATALOG_RESTART_UNSUPPORTED");
      }
    } else if (input.sourceCheckpoint === null ||
      input.sourceCheckpointFingerprint === null ||
      providerMixedCursorFingerprint(input.sourceCheckpoint) !==
        input.sourceCheckpointFingerprint) {
      failure("PROVIDER_DATAFORREST_CURSOR_INVALID");
    }
    const state = this.#state;
    if (state === null) {
      if (input.pageNumber !== 1) {
        failure("PROVIDER_DATAFORREST_CATALOG_RESTART_UNSUPPORTED");
      }
      return;
    }
    if (state.runId !== input.runId) {
      if (!state.reachedHead) failure("PROVIDER_DATAFORREST_TRANSLATION_INVALID");
      if (input.pageNumber !== 1) {
        failure("PROVIDER_DATAFORREST_CATALOG_RESTART_UNSUPPORTED");
      }
      return;
    }
    const prior = state.pages.get(input.pageNumber);
    if (input.pageNumber > 1) {
      const previousPage = state.pages.get(input.pageNumber - 1);
      if (previousPage === undefined ||
        input.sourceCheckpointFingerprint !==
          previousPage.nextCheckpointFingerprint) {
        failure("PROVIDER_DATAFORREST_CURSOR_INVALID");
      }
    }
    if (prior !== undefined) {
      if (prior.requestedCheckpointFingerprint !==
        input.sourceCheckpointFingerprint) {
        failure("PROVIDER_DATAFORREST_CURSOR_INVALID");
      }
      return;
    }
    if (state.reachedHead || input.pageNumber !== state.pages.size + 1) {
      failure("PROVIDER_DATAFORREST_TRANSLATION_INVALID");
    }
  }

  recordPage(input: Readonly<{
    runId: string;
    pageNumber: number;
    pageResponseDigest: string;
    reachedHead: boolean;
    normalizedPage: NormalizedProviderObservationPage;
    sourceCheckpoint: CanonicalJsonValue | null;
    sourceCheckpointFingerprint: string | null;
  }>): ProviderCatalogIdentityCensus {
    this.assertCanRequest(input);
    let state = this.#state;
    if (state === null || state.runId !== input.runId) {
      this.#pageDigestObservationCount = 0;
      this.#maximumPageDigestObservationCount = 0;
      this.#finalDigestDistinctIdentityCount = 0;
      this.#finalDigestComputationCount = 0;
      state = {
        runId: input.runId,
        pages: new Map(),
        identityCounts: new Map(),
        rawCardObservationCount: 0,
        rawPackObservationCount: 0,
        distinctCardIdentityCount: 0,
        distinctPackIdentityCount: 0,
        identityChainDigest: null,
        reachedHead: false,
      };
      this.#state = state;
    }
    const nextCheckpointFingerprint = providerMixedCursorFingerprint(
      input.normalizedPage.nextCursor as unknown as CanonicalJsonValue,
    );
    if (nextCheckpointFingerprint === null) {
      failure("PROVIDER_DATAFORREST_CURSOR_INVALID");
    }
    const prior = state.pages.get(input.pageNumber);
    if (prior !== undefined) {
      if (prior.responseDigest !== input.pageResponseDigest ||
        prior.nextCheckpointFingerprint !== nextCheckpointFingerprint) {
        failure("PROVIDER_DATAFORREST_TRANSLATION_INVALID");
      }
      return prior.census;
    }
    const identities = catalogPageIdentityDigests(input.normalizedPage);
    const pageIdentities = [...identities.cards, ...identities.packs];
    this.#pageDigestObservationCount = safeIdentityCount(
      this.#pageDigestObservationCount,
      pageIdentities.length,
    );
    this.#maximumPageDigestObservationCount = Math.max(
      this.#maximumPageDigestObservationCount,
      pageIdentities.length,
    );
    state.rawCardObservationCount = safeIdentityCount(
      state.rawCardObservationCount,
      identities.cards.length,
    );
    state.rawPackObservationCount = safeIdentityCount(
      state.rawPackObservationCount,
      identities.packs.length,
    );
    for (const digest of identities.cards) {
      const priorCount = state.identityCounts.get(digest) ?? 0;
      state.identityCounts.set(digest, safeIdentityCount(priorCount, 1));
      if (priorCount === 0) {
        state.distinctCardIdentityCount = safeIdentityCount(
          state.distinctCardIdentityCount,
          1,
        );
      }
    }
    for (const digest of identities.packs) {
      const priorCount = state.identityCounts.get(digest) ?? 0;
      state.identityCounts.set(digest, safeIdentityCount(priorCount, 1));
      if (priorCount === 0) {
        state.distinctPackIdentityCount = safeIdentityCount(
          state.distinctPackIdentityCount,
          1,
        );
      }
    }
    const pageIdentityMultisetDigest = providerCatalogIdentityMultisetDigest(
      pageIdentities,
    );
    const identityChainDigest = providerCatalogIdentityChainDigest({
      previousChainDigest: state.identityChainDigest,
      pageNumber: input.pageNumber,
      pageResponseDigest: input.pageResponseDigest,
      pageIdentityMultisetDigest,
    });
    const identityMultisetDigest = input.reachedHead
      ? providerCatalogIdentityCountMapDigest(state.identityCounts)
      : null;
    if (input.reachedHead) {
      this.#finalDigestDistinctIdentityCount = state.identityCounts.size;
      this.#finalDigestComputationCount = safeIdentityCount(
        this.#finalDigestComputationCount,
        1,
      );
    }
    const census = providerCatalogIdentityCensusSchema.parse({
      schemaVersion: "provider_catalog_identity_census_v1",
      pageResponseDigest: input.pageResponseDigest,
      rawCardObservationCount: state.rawCardObservationCount,
      rawPackObservationCount: state.rawPackObservationCount,
      distinctCardIdentityCount: state.distinctCardIdentityCount,
      distinctPackIdentityCount: state.distinctPackIdentityCount,
      identityChainDigest,
      pageIdentityMultisetDigest,
      identityMultisetDigest,
    });
    state.identityChainDigest = identityChainDigest;
    state.reachedHead = input.reachedHead;
    state.pages.set(input.pageNumber, Object.freeze({
      responseDigest: input.pageResponseDigest,
      requestedCheckpointFingerprint: input.sourceCheckpointFingerprint,
      nextCheckpointFingerprint,
      census,
    }));
    return census;
  }

  workSnapshot(): ProviderCatalogIdentityCensusWorkSnapshot {
    return Object.freeze({
      pageDigestObservationCount: this.#pageDigestObservationCount,
      maximumPageDigestObservationCount: this.#maximumPageDigestObservationCount,
      finalDigestDistinctIdentityCount: this.#finalDigestDistinctIdentityCount,
      finalDigestComputationCount: this.#finalDigestComputationCount,
    });
  }
}

function operationIdentity(
  resolved: ResolvedDataforrestSourceAuthority,
  integration: ProviderDataforrestLiveIntegration,
): DataforrestOperationIdentity {
  if (
    integration.declaration.provider !== resolved.providerKey
    || integration.declaration.identityNamespaceKey !==
      integration.mapper.identityNamespaceKey
  ) {
    failure("PROVIDER_DATAFORREST_AUTHORITY_INVALID");
  }
  return Object.freeze({
    sourceInstanceId: resolved.providerId,
    sourceRevisionId: resolved.configVersionId,
    connectionProfileId: resolved.sourceCredentialVersionId,
    connectionProfileRevisionId: resolved.sourceCredentialVersionId,
    identityNamespaceKey: integration.declaration.identityNamespaceKey,
  });
}

function requestedCursor(input: Readonly<{
  checkpoint: CanonicalJsonValue | null;
  checkpointFingerprint: string | null;
  identity: DataforrestOperationIdentity;
  integration: ProviderDataforrestLiveIntegration;
}>): OpaqueCursorEnvelope {
  if (
    providerMixedCursorFingerprint(input.checkpoint)
      !== input.checkpointFingerprint
  ) {
    failure("PROVIDER_DATAFORREST_CURSOR_INVALID");
  }
  if (input.checkpoint === null) {
    return Object.freeze({
      sourceInstanceId: input.identity.sourceInstanceId,
      sourceRevisionId: input.identity.sourceRevisionId,
      sourceTypeKey: input.integration.manifest.sourceTypeKey,
      adapterVersion: input.integration.manifest.adapterVersion,
      cursorCodecKey: input.integration.manifest.cursorCodecKey,
      cursorGeneration: 1,
      value: null,
    });
  }
  const parsed = opaqueCursorEnvelopeSchema.safeParse(input.checkpoint);
  if (
    !parsed.success
    || parsed.data.sourceInstanceId !== input.identity.sourceInstanceId
    || parsed.data.sourceRevisionId !== input.identity.sourceRevisionId
    || parsed.data.sourceTypeKey !== input.integration.manifest.sourceTypeKey
    || parsed.data.adapterVersion !== input.integration.manifest.adapterVersion
    || parsed.data.cursorCodecKey !== input.integration.manifest.cursorCodecKey
    || parsed.data.cursorGeneration !== 1
  ) {
    failure("PROVIDER_DATAFORREST_CURSOR_INVALID");
  }
  return Object.freeze({ ...parsed.data });
}

interface PartitionedDataforrestRecords {
  readonly quarantines: readonly ProviderMixedPageQuarantineRecordDraft[];
}

function adapterInvalidRecordKind(
  evidence: Readonly<Record<string, unknown>>,
): ProviderMixedPageQuarantineRecordDraft["kind"] {
  return evidence.stream === "pulls"
    ? "pull"
    : evidence.stream === "trades"
      ? "market_event"
      : "catalog";
}

function adapterInvalidReasonCode(reasonCode: string): string {
  const prefix = "SOURCE_ADAPTER_";
  const safeReason = reasonCode.toUpperCase()
    .replaceAll(/[^A-Z0-9]+/gu, "_");
  const candidate = `${prefix}${safeReason}`;
  if (candidate.length <= 128) return candidate;
  const digest = createHash("sha256").update(reasonCode).digest("hex")
    .slice(0, 16);
  return `${candidate.slice(0, 128 - digest.length - 1)}_${digest}`;
}

function adapterInvalidSourceScope(
  evidence: Readonly<Record<string, unknown>>,
): string {
  if (evidence.stream === "pulls" || evidence.stream === "trades") {
    return evidence.stream;
  }
  if (evidence.stream === "catalog") {
    return evidence.entity === "pack" || evidence.entity === "card"
      ? `catalog:${evidence.entity}`
      : "catalog:unknown";
  }
  return "unknown";
}

function adapterInvalidSourceRecordKey(input: Readonly<{
  evidence: Readonly<Record<string, unknown>>;
  providerId: string;
}>): string {
  const recordId = typeof input.evidence.record_id === "string"
    && input.evidence.record_id.trim().length > 0
    ? input.evidence.record_id.trim()
    : null;
  const digest = createHash("sha256")
    .update("packscout.provider-source-record-identity.v1\u0000")
    .update(JSON.stringify(recordId === null
      ? [
          input.providerId,
          adapterInvalidSourceScope(input.evidence),
          "record_digest",
          providerMixedPageDigest(input.evidence),
        ]
      : [
          input.providerId,
          adapterInvalidSourceScope(input.evidence),
          recordId,
        ]))
    .digest("hex");
  return `source:${digest}`;
}

function partitionValidatedDataforrestRecords(
  captured: CapturedSourcePageV1,
  providerId: string,
): PartitionedDataforrestRecords {
  const outcomes = captured.normalizedPage.outcomes;
  const evidenceByIndex = new Map<
    number,
    Readonly<Record<string, unknown>>
  >();
  for (const evidence of captured.protectedNativeEvidence) {
    const match = /^page_record:(0|[1-9][0-9]*)$/u.exec(evidence.reference);
    if (match === null) continue;
    const index = Number(match[1]);
    if (
      !Number.isSafeInteger(index)
      || index < 0
      || evidenceByIndex.has(index)
    ) {
      failure("PROVIDER_DATAFORREST_RESPONSE_INVALID");
    }
    evidenceByIndex.set(index, evidence.value);
  }
  if (
    evidenceByIndex.size !== outcomes.length
    || outcomes.some((outcome, index) => outcome.recordIndex !== index)
  ) {
    failure("PROVIDER_DATAFORREST_RESPONSE_INVALID");
  }
  const quarantines: ProviderMixedPageQuarantineRecordDraft[] = [];
  for (const [index, outcome] of outcomes.entries()) {
    const expectedReference = `page_record:${index}`;
    const evidence = evidenceByIndex.get(index)
      ?? failure("PROVIDER_DATAFORREST_RESPONSE_INVALID");
    const outcomeReference = outcome.status === "valid"
      ? outcome.observation.protectedNativeEvidenceRef
      : outcome.protectedNativeEvidenceRef;
    if (outcomeReference !== expectedReference) {
      failure("PROVIDER_DATAFORREST_RESPONSE_INVALID");
    }
    if (outcome.status === "valid") {
      continue;
    }
    quarantines.push(Object.freeze({
      kind: adapterInvalidRecordKind(evidence),
      disposition: "quarantine" as const,
      candidate: Object.freeze({}),
      sourceRecordKey: adapterInvalidSourceRecordKey({
        evidence,
        providerId,
      }),
      reasonCode: adapterInvalidReasonCode(outcome.reasonCode),
      fieldPath: outcome.fieldPaths[0] ?? null,
      sanitizedSummary:
        "The source adapter rejected this record before canonical translation; no retry artifact is retained.",
    }));
  }
  return Object.freeze({
    quarantines: Object.freeze(quarantines),
  });
}

function mixedPage(input: Readonly<{
  request: ProviderCapturePageSourceInput;
  captured: CapturedSourcePageV1;
  translation: ProviderCaptureTranslation;
}>): CanonicalJsonObject {
  if (input.translation.records.length > PROVIDER_MIXED_PAGE_MAX_RECORDS) {
    failure("PROVIDER_DATAFORREST_PAGE_INVALID");
  }
  const continuation =
    input.captured.normalizedPage.continuation.kind === "continue"
      ? "more"
      : "head";
  const nextCursor = input.captured.normalizedPage.nextCursor as
    unknown as CanonicalJsonObject;
  const records = input.translation.records.map((record, position) => ({
    position,
    providerId: input.request.authority.providerId,
    ...record,
  }));
  const body: CanonicalJsonObject = {
    contractVersion: PROVIDER_MIXED_PAGE_CONTRACT_VERSION,
    providerId: input.request.authority.providerId,
    runId: input.request.runId,
    configVersionId: input.request.authority.configVersionId,
    configVersionNumber:
      input.request.authority.configVersionNumber.toString(),
    leaseFence: input.request.workerFence.toString(),
    pageId: deterministicUuid([
      "packscout.provider-dataforrest-page.v1",
      input.request.runId,
      input.request.authority.configVersionId,
      input.request.authority.configVersionNumber.toString(),
      input.request.workerFence.toString(),
      input.request.pageNumber.toString(),
      input.request.sourceCheckpointFingerprint ?? "initial",
      providerMixedPageDigest(records),
    ].join("\u0000")),
    pageNumber: input.request.pageNumber,
    inputCursor: input.request.sourceCheckpoint,
    inputCursorFingerprint: input.request.sourceCheckpointFingerprint,
    nextCursor,
    nextCursorFingerprint: providerMixedCursorFingerprint(nextCursor),
    continuation,
    records,
  };
  const page: CanonicalJsonObject = {
    ...body,
    responseDigest: providerMixedPageDigest(body),
  };
  try {
    validateProviderMixedPage(page);
    if (providerMixedPageCanonicalBytes(page).byteLength >
      PROVIDER_MIXED_PAGE_MAX_BYTES) {
      failure("PROVIDER_DATAFORREST_PAGE_INVALID");
    }
  } catch (error) {
    if (error instanceof ProviderDataforrestSourceError) throw error;
    failure("PROVIDER_DATAFORREST_PAGE_INVALID");
  }
  return Object.freeze(page);
}

function safeUnexpectedFailure(error: unknown): never {
  if (error instanceof ProviderDataforrestSourceError) throw error;
  return failure("PROVIDER_DATAFORREST_RESPONSE_INVALID");
}

function adapterMatchesIntegration(
  adapter: SourceAdapter,
  integration: ProviderDataforrestLiveIntegration,
): boolean {
  return adapter.manifest.sourceTypeKey === integration.manifest.sourceTypeKey
    && adapter.manifest.adapterVersion === integration.manifest.adapterVersion
    && adapter.manifest.normalizedContractVersion ===
      integration.manifest.normalizedContractVersion
    && adapter.manifest.cursorCodecKey === integration.manifest.cursorCodecKey
    && adapter.manifest.requestBounds.pageLimit ===
      integration.manifest.requestBounds.pageLimit
    && adapter.manifest.requestBounds.maximumResponseBytes ===
      integration.manifest.requestBounds.maximumResponseBytes
    && adapter.manifest.requestBounds.timeoutMilliseconds ===
      integration.manifest.requestBounds.timeoutMilliseconds
    && adapter.manifest.maximumPlatformRequestCap ===
      integration.manifest.maximumPlatformRequestCap
    && adapter.manifest.supportedProviders.some((declaration) =>
      declaration.provider === integration.providerKey
      && declaration.identityNamespaceKey ===
        integration.declaration.identityNamespaceKey
    );
}

/** Live, bounded DataForrest-to-provider mixed-page bridge. */
export class ProviderDataforrestMixedPageSource
  implements ProviderManualImportPageSource {
  readonly #adapter: SourceAdapter;
  readonly #authorityResolver: DataforrestSourceAuthorityResolver;
  readonly #coordinator = new ConnectionPermitCoordinator(1);
  readonly #requestLeases = new SourceRequestLeaseAuthority(this.#coordinator);
  readonly #terminalizeRequest: SourceAdapterRequestTerminalizer;
  readonly #translationRecorder: ProviderDataforrestPageTranslationRecorder;
  readonly #workerId: string;
  readonly #integration: ProviderDataforrestLiveIntegration;
  readonly #maximumPageRecords: number | undefined;
  readonly #catalogIdentityCensusSession: ProviderCatalogIdentityCensusSession;

  constructor(input: Readonly<{
    authorityResolver: DataforrestSourceAuthorityResolver;
    terminalizeRequest: SourceAdapterRequestTerminalizer;
    translationRecorder: ProviderDataforrestPageTranslationRecorder;
    workerId: string;
    integration: ProviderDataforrestLiveIntegration;
    adapter?: SourceAdapter;
    catalogIdentityCensusSession?: ProviderCatalogIdentityCensusSession;
    /** Runtime resource ceiling; never changes the adapter's maximum or identity. */
    maximumPageRecords?: number;
  }>) {
    if (input.maximumPageRecords !== undefined &&
      (!Number.isSafeInteger(input.maximumPageRecords) || input.maximumPageRecords < 1)) {
      throw new TypeError("DataForrest page record ceiling is invalid.");
    }
    this.#maximumPageRecords = input.maximumPageRecords;
    this.#authorityResolver = input.authorityResolver;
    this.#terminalizeRequest = input.terminalizeRequest;
    this.#translationRecorder = input.translationRecorder;
    this.#workerId = input.workerId;
    this.#integration = input.integration;
    this.#catalogIdentityCensusSession = input.catalogIdentityCensusSession ??
      new ProviderCatalogIdentityCensusSession();
    this.#adapter = input.adapter ?? new DataforrestEventsSourceAdapter(
      {},
      input.integration.manifest,
    );
    if (!adapterMatchesIntegration(this.#adapter, input.integration)) {
      throw new TypeError("DataForrest adapter does not match live integration.");
    }
  }

  supports(adapterKey: string, providerKey: string): boolean {
    return adapterKey === this.#integration.manifest.adapterVersion
      && providerKey === this.#integration.providerKey
      && adapterMatchesIntegration(this.#adapter, this.#integration);
  }

  catalogIdentityCensusWorkSnapshot(): ProviderCatalogIdentityCensusWorkSnapshot {
    return this.#catalogIdentityCensusSession.workSnapshot();
  }

  async nextPage(input: ProviderCapturePageSourceInput): Promise<unknown> {
    if (input.signal.aborted) {
      failure("PROVIDER_DATAFORREST_ABORTED");
    }
    if (
      input.authority.providerKey !== this.#integration.providerKey
      || !Number.isSafeInteger(input.pageNumber)
      || input.pageNumber < 1
    ) {
      failure("PROVIDER_DATAFORREST_AUTHORITY_INVALID");
    }
    const adapterKey = selectedAdapterKey(input.authority);
    if (!this.supports(adapterKey, input.authority.providerKey)) {
      failure("PROVIDER_DATAFORREST_AUTHORITY_INVALID");
    }
    let resolved: ResolvedDataforrestSourceAuthority;
    try {
      resolved = await this.#authorityResolver.resolve({
        providerId: input.authority.providerId,
        providerKey: input.authority.providerKey,
        configVersionId: input.authority.configVersionId,
        configVersionNumber: input.authority.configVersionNumber,
        adapterKey,
      });
    } catch {
      failure("PROVIDER_DATAFORREST_AUTHORITY_UNAVAILABLE");
    }
    validateResolvedAuthority(input, adapterKey, resolved, this.#integration);
    const catalogSource = isCatalogSource(resolved);
    if (catalogSource) {
      this.#catalogIdentityCensusSession.assertCanRequest({
        runId: input.runId,
        pageNumber: input.pageNumber,
        sourceCheckpoint: input.sourceCheckpoint,
        sourceCheckpointFingerprint: input.sourceCheckpointFingerprint,
      });
    }
    const identity = operationIdentity(resolved, this.#integration);
    const cursor = requestedCursor({
      checkpoint: input.sourceCheckpoint,
      checkpointFingerprint: input.sourceCheckpointFingerprint,
      identity,
      integration: this.#integration,
    });
    const manifest = this.#adapter.manifest;
    const bounds = Object.freeze({ ...manifest.requestBounds,
      pageLimit: Math.min(manifest.requestBounds.pageLimit,
        this.#maximumPageRecords ?? manifest.requestBounds.pageLimit) });
    const declaration = manifest.supportedProviders.find(
      ({ provider }) => provider === this.#integration.providerKey,
    );
    if (
      declaration === undefined
      || !adapterMatchesIntegration(this.#adapter, this.#integration)
    ) {
      failure("PROVIDER_DATAFORREST_AUTHORITY_INVALID");
    }
    this.#coordinator.configureRequestPermitLane({
      organizationId: resolved.organizationId,
      connectionProfileId: identity.connectionProfileId,
      scope: "platform",
      providerId: resolved.providerId,
      approvedRequestCap: manifest.maximumPlatformRequestCap,
    });
    const requestAttemptId = randomUUID();
    const requestLeaseId = randomUUID();
    const workerGeneration = safeGeneration(input.workerFence);
    const pins = Object.freeze({
      operationKind: "page_read" as const,
      requestAttemptId,
      requestLeaseId,
      organizationId: resolved.organizationId,
      sourceTypeKey: manifest.sourceTypeKey,
      adapterVersion: manifest.adapterVersion,
      singletonFencingEpoch: workerGeneration,
      connectionProfileId: identity.connectionProfileId,
      connectionProfileRevisionId: identity.connectionProfileRevisionId,
      connectionHealthGeneration: 0,
      provider: this.#integration.providerKey,
      providerId: resolved.providerId,
      sourceInstanceId: identity.sourceInstanceId,
      sourceRevisionId: identity.sourceRevisionId,
      normalizedContractVersion: manifest.normalizedContractVersion,
      identityNamespaceKey: identity.identityNamespaceKey,
      importRunId: input.runId,
      runClaimLeaseId: `${input.runId}:${input.workerFence.toString()}`,
      pageAttemptId: randomUUID(),
      pageNumber: input.pageNumber,
      pageLimit: bounds.pageLimit,
      cursorGeneration: 1,
      requestedCursorFingerprint: input.sourceCheckpointFingerprint,
    });
    const requestLease = await this.#requestLeases.admit({
      pins,
      requestedCursor: cursor,
      guard: () => !input.signal.aborted,
      signal: input.signal,
    }).catch(() => failure(
      input.signal.aborted
        ? "PROVIDER_DATAFORREST_ABORTED"
        : "PROVIDER_DATAFORREST_AUTHORITY_UNAVAILABLE",
    ));
    let abandoned = false;
    let protectedRawResponse: Uint8Array | null = null;
    try {
      const operation = createPageReadOperation({
        organizationId: resolved.organizationId,
        sourceTypeKey: manifest.sourceTypeKey,
        adapterVersion: manifest.adapterVersion,
        connectionProfileId: identity.connectionProfileId,
        connectionProfileRevisionId: identity.connectionProfileRevisionId,
        connectionConfiguration: resolved.connectionConfiguration,
        requestLease,
        bounds,
        operationKind: "page_read",
        provider: this.#integration.providerKey,
        providerId: resolved.providerId,
        sourceInstanceId: identity.sourceInstanceId,
        sourceRevisionId: identity.sourceRevisionId,
        normalizedContractVersion: manifest.normalizedContractVersion,
        identityNamespaceKey: identity.identityNamespaceKey,
        recordIdScopes: declaration.recordIdScopes,
        sourceConfiguration: resolved.sourceConfiguration,
        correlation: {
          singletonFencingEpoch: workerGeneration,
          connectionHealthGeneration: 0,
          importRunId: input.runId,
          runClaimLeaseId: pins.runClaimLeaseId,
          pageAttemptId: pins.pageAttemptId,
          pageNumber: input.pageNumber,
          cursorGeneration: 1,
          requestedCursorFingerprint: input.sourceCheckpointFingerprint,
          requestedCursor: cursor,
          pageLimit: bounds.pageLimit,
        },
      });
      const request = await captureAndTerminalizeSourceAdapterRequest(
        this.#requestLeases,
        this.#adapter,
        operation,
        this.#terminalizeRequest,
      );
      if (!request.ok) {
        const completed = completeSourceAdapterRequestFailure(
          operation,
          request,
        );
        if (completed.ok) {
          failure("PROVIDER_DATAFORREST_RESPONSE_INVALID");
        }
        return adapterFailure(completed.failure.code);
      }
      protectedRawResponse = request.value.protectedRawResponse;
      const interpretation = await interpretSourceAdapterPage(
        this.#adapter,
        operation,
        request,
      );
      const completed = completeSourceAdapterPageRead(
        operation,
        sourceAdapterInterpretationContextOf(operation),
        request,
        interpretation,
      );
      if (!completed.ok) adapterFailure(completed.failure.code);
      let translation: ProviderCaptureTranslation;
      try {
        const partition = partitionValidatedDataforrestRecords(
          completed.value,
          resolved.providerId,
        );
        const translated = translateProviderNormalizedObservations({
          organizationId: resolved.organizationId,
          providerId: resolved.providerId,
          integration: this.#integration,
          page: completed.value.normalizedPage,
        });
        translation = Object.freeze({
          records: Object.freeze([
            ...translated.records,
            ...partition.quarantines,
          ]),
          counts: translated.counts,
        });
      } catch {
        failure("PROVIDER_DATAFORREST_TRANSLATION_INVALID");
      }
      const page = mixedPage({
        request: input,
        captured: completed.value,
        translation,
      });
      const pageResponseDigest = page.responseDigest;
      if (typeof pageResponseDigest !== "string") {
        failure("PROVIDER_DATAFORREST_PAGE_INVALID");
      }
      const catalogIdentityCensus = catalogSource
        ? this.#catalogIdentityCensusSession.recordPage({
            runId: input.runId,
            pageNumber: input.pageNumber,
            pageResponseDigest,
            reachedHead:
              completed.value.normalizedPage.continuation.kind !== "continue",
            normalizedPage: completed.value.normalizedPage,
            sourceCheckpoint: input.sourceCheckpoint,
            sourceCheckpointFingerprint: input.sourceCheckpointFingerprint,
          })
        : null;
      let translationReceipt: Awaited<ReturnType<
        ProviderDataforrestPageTranslationRecorder["recordPageTranslation"]
      >>;
      try {
        translationReceipt = await this.#translationRecorder
          .recordPageTranslation({
            runId: input.runId,
            workerId: this.#workerId,
            workerFence: input.workerFence,
            requestAttemptId,
            pageAttemptId: pins.pageAttemptId,
            pageNumber: input.pageNumber,
            sourceRecordCount: completed.value.normalizedPage.outcomes.length,
            normalizedRecordCount: translation.records.length,
            recordCounts: countProviderPageRecords(translation.records),
            catalogIdentityCensus,
          });
      } catch {
        failure("PROVIDER_DATAFORREST_TERMINALIZATION_FAILED");
      }
      if (translationReceipt.kind !== "recorded") {
        failure("PROVIDER_DATAFORREST_TERMINALIZATION_FAILED");
      }
      return page;
    } catch (error) {
      if (requestLease.requestPermitHeld && requestLease.state !== "available") {
        this.#requestLeases.stopAdmission();
        this.#requestLeases.abandonLocallyFencedLease(requestLease);
        abandoned = true;
        failure("PROVIDER_DATAFORREST_TERMINALIZATION_FAILED");
      }
      return safeUnexpectedFailure(error);
    } finally {
      protectedRawResponse?.fill(0);
      if (!abandoned) {
        if (
          !requestLease.requestPermitHeld
          && requestLease.executionSlotHeld
          && requestLease.state !== "available"
        ) {
          requestLease.releaseExecutionSlot();
        }
        requestLease.close();
      }
    }
  }
}
