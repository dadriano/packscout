import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  PROVIDER_OBSERVATION_HASH_VERSION,
  launchRecordIdScopeDeclarations,
  normalizedObservationSemanticContentSchema,
  normalizedObservationSemanticCanonicalJson,
  type NormalizedObservationSemanticContent,
} from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import type { PackscoutTransactionClient } from "./database.ts";
import { PersistenceError } from "./persistence-error.ts";
import { createHash } from "node:crypto";

const SHA_256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_REASON_CODE_PATTERN = /^[a-z0-9](?:[a-z0-9:._-]{0,254}[a-z0-9])?$/;

function asJson(
  value: NormalizedObservationSemanticContent,
): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export type LaunchSourceRecordMeaning =
  | Readonly<{
      recordKind: "catalog";
      recordDiscriminator: "catalog_pack" | "catalog_card";
    }>
  | Readonly<{
      recordKind: "pull";
      recordDiscriminator: "pull";
    }>
  | Readonly<{
      recordKind: "trade";
      recordDiscriminator: "trade";
    }>;

export type UpsertSemanticObservationInput = Readonly<{
  organizationId: string;
  providerId: string;
  sourceInstanceId: string;
  sourceRevisionId: string;
  recordIdScopeKey: string;
  providerRecordId: string;
  effectiveSourceTime: Date;
  normalizedContractVersion: typeof PROVIDER_OBSERVATION_CONTRACT_VERSION;
  hashVersion: typeof PROVIDER_OBSERVATION_HASH_VERSION;
  normalizedContentHash: string;
  normalizedContent: NormalizedObservationSemanticContent;
}> &
  LaunchSourceRecordMeaning;

/** Resolves launch scope meaning only from the shared provider contract. */
export function resolveLaunchSourceRecordMeaning(
  recordIdScopeKey: string,
): LaunchSourceRecordMeaning {
  const declaration = launchRecordIdScopeDeclarations.find(
    (candidate) => candidate.recordIdScopeKey === recordIdScopeKey,
  );
  if (!declaration) {
    throw new TypeError("Record-ID scope is not part of the launch contract.");
  }
  if (declaration.sourceKind === "catalog") {
    return {
      recordKind: "catalog",
      recordDiscriminator:
        declaration.catalogEntity === "pack" ? "catalog_pack" : "catalog_card",
    };
  }
  if (declaration.sourceKind === "pull") {
    return { recordKind: "pull", recordDiscriminator: "pull" };
  }
  return { recordKind: "trade", recordDiscriminator: "trade" };
}

/** Canonical semantic hash for PROVIDER_OBSERVATION_HASH_VERSION. */
export function hashNormalizedObservationSemanticContent(
  normalizedContent: unknown,
): string {
  return createHash("sha256")
    .update(normalizedObservationSemanticCanonicalJson(normalizedContent))
    .digest("hex");
}

function parseBoundSemanticContent(
  input: UpsertSemanticObservationInput,
  expectedMeaning: LaunchSourceRecordMeaning,
): NormalizedObservationSemanticContent {
  const content = normalizedObservationSemanticContentSchema.parse(
    input.normalizedContent,
  );
  if (
    content.providerRecordIdentity.recordIdScopeKey !==
      input.recordIdScopeKey ||
    content.providerRecordIdentity.providerRecordId !== input.providerRecordId
  ) {
    throw new TypeError(
      "Normalized semantic provider identity does not match its source-record key.",
    );
  }
  if (
    !Number.isFinite(input.effectiveSourceTime.getTime()) ||
    new Date(content.effectiveAt).getTime() !==
      input.effectiveSourceTime.getTime()
  ) {
    throw new TypeError(
      "Normalized semantic effective time does not match its observation key.",
    );
  }
  const contentMeaning: LaunchSourceRecordMeaning =
    content.kind === "catalog"
      ? {
          recordKind: "catalog",
          recordDiscriminator:
            content.entity === "pack" ? "catalog_pack" : "catalog_card",
        }
      : content.kind === "pull"
        ? { recordKind: "pull", recordDiscriminator: "pull" }
        : { recordKind: "trade", recordDiscriminator: "trade" };
  if (
    contentMeaning.recordKind !== expectedMeaning.recordKind ||
    contentMeaning.recordDiscriminator !== expectedMeaning.recordDiscriminator
  ) {
    throw new TypeError(
      "Normalized semantic kind or catalog entity does not match its source-record key.",
    );
  }
  return content;
}

/**
 * A stable source identity conflict has no semantic observation. The page
 * planner can retain the source-record lineage and assign the quarantined
 * delivery disposition later in the same atomic page transaction.
 */
export type UpsertSemanticObservationResult =
  | Readonly<{
      kind: "ready";
      sourceRecordId: string;
      semanticObservationId: string;
      semanticObservationCreated: boolean;
    }>
  | Readonly<{
      kind: "identity_conflict";
      sourceRecordId: string;
      semanticObservationId: null;
      reasonCode: "source_identity_conflict";
    }>;

export type SourceDeliveryDisposition =
  "inserted" | "revised" | "duplicate" | "quarantined";

type SourceDeliveryDecision =
  | Readonly<{
      disposition: Exclude<SourceDeliveryDisposition, "quarantined">;
      sourceRecordId: string;
      semanticObservationId: string;
      reasonCode?: null;
    }>
  | Readonly<{
      disposition: "quarantined";
      sourceRecordId: string | null;
      semanticObservationId: string | null;
      reasonCode: string;
    }>;

export type RecordDeliveryOccurrenceInput = Readonly<{
  organizationId: string;
  providerId: string;
  sourceInstanceId: string;
  sourceRevisionId: string;
  runId: string;
  pageId: string;
  recordIndex: number;
  requestAttemptId: string;
  sourceTypeKey: string;
  sourceAdapterVersion: string;
  normalizedContractVersion: string;
  mapperKey: string;
  mapperVersion: string;
  identityNamespaceKey: string;
  checkpointCodecVersion: string;
  checkpointGeneration: bigint;
  connectionHealthGeneration: bigint;
  supervisorEpochId: string;
  connectionProfileId: string;
  connectionRevisionId: string;
  collectedAt: Date;
  nativeEvidenceReference: string;
}> &
  SourceDeliveryDecision;

export class ProviderSourceObservationRepository {
  /**
   * Persists only stable identity and semantic meaning. The caller owns the
   * transaction and must assign the canonical outcome and delivery occurrence
   * after mapping, conflict checks, and derived work have all succeeded.
   */
  async upsertSemanticObservationInTransaction(
    transaction: PackscoutTransactionClient,
    input: UpsertSemanticObservationInput,
    options?: Readonly<{
      /**
       * Skips the page-constant source-revision fence lookup. Only pass true
       * when the same transaction already verified the identical
       * (organizationId, providerId, sourceInstanceId, sourceRevisionId) fence
       * through an earlier call with the check enabled.
       */
      skipSourceRevisionFenceCheck?: boolean;
    }>,
  ): Promise<UpsertSemanticObservationResult> {
    const expectedMeaning = resolveLaunchSourceRecordMeaning(
      input.recordIdScopeKey,
    );
    if (
      input.recordKind !== expectedMeaning.recordKind ||
      input.recordDiscriminator !== expectedMeaning.recordDiscriminator
    ) {
      throw new TypeError(
        `Record-ID scope ${input.recordIdScopeKey} requires ${expectedMeaning.recordKind}/${expectedMeaning.recordDiscriminator}.`,
      );
    }
    if (
      input.normalizedContractVersion !== PROVIDER_OBSERVATION_CONTRACT_VERSION
    ) {
      throw new TypeError(
        "Normalized observation contract version is unsupported.",
      );
    }
    if (input.hashVersion !== PROVIDER_OBSERVATION_HASH_VERSION) {
      throw new TypeError(
        "Normalized observation hash version is unsupported.",
      );
    }
    if (!SHA_256_PATTERN.test(input.normalizedContentHash)) {
      throw new TypeError(
        "Normalized content hash must be a lowercase SHA-256 digest.",
      );
    }
    const normalizedContent = parseBoundSemanticContent(input, expectedMeaning);
    const normalizedContentHash =
      hashNormalizedObservationSemanticContent(normalizedContent);
    if (input.normalizedContentHash !== normalizedContentHash) {
      throw new TypeError(
        "Normalized content hash does not match canonical semantic content.",
      );
    }

    if (options?.skipSourceRevisionFenceCheck !== true) {
      const source = await transaction.provider_source_instances.findFirst({
        where: {
          id: input.sourceInstanceId,
          organization_id: input.organizationId,
          provider_id: input.providerId,
        },
        select: { active_revision_id: true },
      });
      if (!source || source.active_revision_id !== input.sourceRevisionId) {
        throw new PersistenceError(
          "SOURCE_FENCED",
          "Observation source revision is not current.",
        );
      }
    }

    const sourceRecord = await transaction.source_record_identities.upsert({
      where: {
        organization_id_source_instance_id_record_id_scope_key_provider_record_id:
          {
            organization_id: input.organizationId,
            source_instance_id: input.sourceInstanceId,
            record_id_scope_key: input.recordIdScopeKey,
            provider_record_id: input.providerRecordId,
          },
      },
      create: {
        organization_id: input.organizationId,
        provider_id: input.providerId,
        source_instance_id: input.sourceInstanceId,
        record_id_scope_key: input.recordIdScopeKey,
        provider_record_id: input.providerRecordId,
        record_kind: input.recordKind,
        record_discriminator: input.recordDiscriminator,
      },
      update: {},
    });
    if (
      sourceRecord.record_kind !== input.recordKind ||
      sourceRecord.record_discriminator !== input.recordDiscriminator
    ) {
      return {
        kind: "identity_conflict",
        sourceRecordId: sourceRecord.id,
        semanticObservationId: null,
        reasonCode: "source_identity_conflict",
      };
    }

    const semanticIdentity = {
      source_record_id: sourceRecord.id,
      effective_source_time: input.effectiveSourceTime,
      normalized_contract_version: input.normalizedContractVersion,
      hash_version: input.hashVersion,
      normalized_content_hash: normalizedContentHash,
    };
    const inserted = await transaction.source_semantic_observations.createMany({
      data: {
        organization_id: input.organizationId,
        ...semanticIdentity,
        normalized_content_json: asJson(normalizedContent),
      },
      skipDuplicates: true,
    });
    const observation =
      await transaction.source_semantic_observations.findUniqueOrThrow({
        where: {
          source_record_id_effective_source_time_normalized_contract_version_hash_version_normalized_content_hash:
            semanticIdentity,
        },
        select: { id: true },
      });
    return {
      kind: "ready",
      sourceRecordId: sourceRecord.id,
      semanticObservationId: observation.id,
      semanticObservationCreated: inserted.count === 1,
    };
  }

  /** Records Task 006's final record disposition inside its page transaction. */
  async recordDeliveryOccurrenceInTransaction(
    transaction: PackscoutTransactionClient,
    input: RecordDeliveryOccurrenceInput,
  ): Promise<{ occurrenceId: bigint }> {
    validateDeliveryOccurrenceInput(input);
    const occurrence = await transaction.source_delivery_occurrences.create({
      data: deliveryOccurrenceRow(input),
      select: { id: true },
    });
    return { occurrenceId: occurrence.id };
  }

  /**
   * Records many final record dispositions in one statement. Validation is
   * identical to {@link recordDeliveryOccurrenceInTransaction} for every row
   * and runs completely before the insert. Use only when no caller needs the
   * generated occurrence ids.
   */
  async recordDeliveryOccurrencesInTransaction(
    transaction: PackscoutTransactionClient,
    inputs: readonly RecordDeliveryOccurrenceInput[],
  ): Promise<void> {
    for (const input of inputs) validateDeliveryOccurrenceInput(input);
    if (inputs.length === 0) return;
    await transaction.source_delivery_occurrences.createMany({
      data: inputs.map(deliveryOccurrenceRow),
    });
  }
}

function validateDeliveryOccurrenceInput(
  input: RecordDeliveryOccurrenceInput,
): void {
  if (!Number.isSafeInteger(input.recordIndex) || input.recordIndex < 0) {
    throw new TypeError(
      "Delivery record index must be a nonnegative safe integer.",
    );
  }
  if (input.disposition === "quarantined") {
    if (!SAFE_REASON_CODE_PATTERN.test(input.reasonCode)) {
      throw new TypeError(
        "Quarantine reason code must be a bounded safe reference.",
      );
    }
    if (
      input.semanticObservationId !== null &&
      input.sourceRecordId === null
    ) {
      throw new TypeError(
        "A semantic observation cannot exist without its source record.",
      );
    }
  } else if (input.reasonCode !== undefined && input.reasonCode !== null) {
    throw new TypeError(
      "Only quarantined deliveries may carry a reason code.",
    );
  }
}

function deliveryOccurrenceRow(input: RecordDeliveryOccurrenceInput) {
  return {
    organization_id: input.organizationId,
    provider_id: input.providerId,
    source_instance_id: input.sourceInstanceId,
    source_revision_id: input.sourceRevisionId,
    run_id: input.runId,
    page_id: input.pageId,
    record_index: input.recordIndex,
    source_record_id: input.sourceRecordId,
    semantic_observation_id: input.semanticObservationId,
    request_attempt_id: input.requestAttemptId,
    source_type_key: input.sourceTypeKey,
    source_adapter_version: input.sourceAdapterVersion,
    normalized_contract_version: input.normalizedContractVersion,
    mapper_key: input.mapperKey,
    mapper_version: input.mapperVersion,
    identity_namespace_key: input.identityNamespaceKey,
    checkpoint_codec_version: input.checkpointCodecVersion,
    checkpoint_generation: input.checkpointGeneration,
    connection_health_generation: input.connectionHealthGeneration,
    supervisor_epoch_id: input.supervisorEpochId,
    connection_profile_id: input.connectionProfileId,
    connection_revision_id: input.connectionRevisionId,
    collected_at: input.collectedAt,
    native_evidence_reference: input.nativeEvidenceReference,
    disposition: input.disposition,
    reason_code:
      input.disposition === "quarantined" ? input.reasonCode : null,
  } as const;
}
