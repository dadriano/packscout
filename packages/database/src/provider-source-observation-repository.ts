import { createHash } from "node:crypto";
import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  PROVIDER_OBSERVATION_HASH_VERSION,
  launchRecordIdScopeDeclarations,
  normalizedObservationSemanticCanonicalJson,
  normalizedObservationSemanticContentSchema,
  type NormalizedObservationSemanticContent,
} from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import type { PackscoutTransactionClient } from "./database.ts";
import { PersistenceError } from "./persistence-error.ts";

const SHA_256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_REASON_CODE_PATTERN = /^[a-z0-9](?:[a-z0-9:._-]{0,254}[a-z0-9])?$/;
const MAXIMUM_ROWS_PER_WRITE = 500;

function asJson(
  value: NormalizedObservationSemanticContent,
): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function jsonValue(value: unknown): Prisma.Sql {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("Persistence JSON values must be serializable.");
  }
  return Prisma.sql`cast(${serialized} as jsonb)`;
}

function batches<T>(values: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += MAXIMUM_ROWS_PER_WRITE) {
    result.push(values.slice(index, index + MAXIMUM_ROWS_PER_WRITE));
  }
  return result;
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

type UpsertSemanticObservationCommon = Readonly<{
  organizationId: string;
  providerId: string;
  sourceInstanceId: string;
  sourceRevisionId: string;
  recordIdScopeKey: string;
  providerRecordId: string;
  effectiveSourceTime: Date;
  normalizedContentHash: string;
}> & LaunchSourceRecordMeaning;

export type UpsertSemanticObservationInput = UpsertSemanticObservationCommon &
  Readonly<{
    normalizedContractVersion:
      ProviderSourceObservationVersionPins["normalizedContractVersion"];
    hashVersion: ProviderSourceObservationVersionPins["hashVersion"];
    normalizedContent: NormalizedObservationSemanticContent;
  }>;

export type ProviderSourceObservationVersionPins = Readonly<{
  normalizedContractVersion: typeof PROVIDER_OBSERVATION_CONTRACT_VERSION;
  hashVersion: typeof PROVIDER_OBSERVATION_HASH_VERSION;
}>;

/** Exact persistence-domain dispatch; unknown versions never fall back. */
export function providerSourceObservationVersionPins(
  normalizedContractVersion: string,
): ProviderSourceObservationVersionPins {
  if (normalizedContractVersion === PROVIDER_OBSERVATION_CONTRACT_VERSION) {
    return {
      normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
      hashVersion: PROVIDER_OBSERVATION_HASH_VERSION,
    };
  }
  throw new TypeError("Normalized observation contract version is unsupported.");
}

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

interface PreparedSemanticObservation {
  readonly input: UpsertSemanticObservationInput;
  readonly normalizedContent: NormalizedObservationSemanticContent;
  readonly normalizedContentHash: string;
}

function prepareSemanticObservation(
  input: UpsertSemanticObservationInput,
): PreparedSemanticObservation {
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
  const versionPins = providerSourceObservationVersionPins(
    input.normalizedContractVersion,
  );
  if (input.hashVersion !== versionPins.hashVersion) {
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
  return { input, normalizedContent, normalizedContentHash };
}

function sourceRecordIdentityKey(input: Readonly<{
  recordIdScopeKey: string;
  providerRecordId: string;
}>): string {
  return JSON.stringify([input.recordIdScopeKey, input.providerRecordId]);
}

function semanticObservationIdentityKey(input: Readonly<{
  sourceRecordId: string;
  effectiveSourceTime: Date;
  normalizedContractVersion: string;
  hashVersion: string;
  normalizedContentHash: string;
}>): string {
  return JSON.stringify([
    input.sourceRecordId,
    input.effectiveSourceTime.toISOString(),
    input.normalizedContractVersion,
    input.hashVersion,
    input.normalizedContentHash,
  ]);
}

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
  cursorCodecVersion: string;
  cursorGeneration: bigint;
  connectionHealthGeneration: bigint;
  supervisorEpochId: string;
  connectionProfileId: string;
  connectionRevisionId: string;
  collectedAt: Date;
  nativeEvidenceReference: string;
}> &
  SourceDeliveryDecision;

export interface RecordedDeliveryOccurrence {
  readonly recordIndex: number;
  readonly occurrenceId: bigint;
}

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
    const { normalizedContent, normalizedContentHash } =
      prepareSemanticObservation(input);

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

  /**
   * Resolves a complete page of stable identities and semantic observations in
   * bounded statements. Validation finishes before the first database write,
   * and result order exactly matches input order (including duplicates).
   */
  async upsertSemanticObservationsInTransaction(
    transaction: PackscoutTransactionClient,
    inputs: readonly UpsertSemanticObservationInput[],
  ): Promise<readonly UpsertSemanticObservationResult[]> {
    const prepared = inputs.map(prepareSemanticObservation);
    if (prepared.length === 0) return [];
    const scope = prepared[0]!.input;
    if (
      prepared.some(({ input }) =>
        input.organizationId !== scope.organizationId ||
        input.providerId !== scope.providerId ||
        input.sourceInstanceId !== scope.sourceInstanceId ||
        input.sourceRevisionId !== scope.sourceRevisionId
      )
    ) {
      throw new TypeError(
        "Semantic observation batches cannot span tenant, provider, source, or revision scopes.",
      );
    }

    const source = await transaction.provider_source_instances.findFirst({
      where: {
        id: scope.sourceInstanceId,
        organization_id: scope.organizationId,
        provider_id: scope.providerId,
      },
      select: { active_revision_id: true },
    });
    if (!source || source.active_revision_id !== scope.sourceRevisionId) {
      throw new PersistenceError(
        "SOURCE_FENCED",
        "Observation source revision is not current.",
      );
    }

    const uniqueIdentityByKey = new Map<string, UpsertSemanticObservationInput>();
    for (const { input } of prepared) {
      const key = sourceRecordIdentityKey(input);
      if (!uniqueIdentityByKey.has(key)) uniqueIdentityByKey.set(key, input);
    }
    const uniqueIdentities = [...uniqueIdentityByKey.values()];
    for (const batch of batches(uniqueIdentities)) {
      await transaction.source_record_identities.createMany({
        data: batch.map((input) => ({
          organization_id: input.organizationId,
          provider_id: input.providerId,
          source_instance_id: input.sourceInstanceId,
          record_id_scope_key: input.recordIdScopeKey,
          provider_record_id: input.providerRecordId,
          record_kind: input.recordKind,
          record_discriminator: input.recordDiscriminator,
        })),
        skipDuplicates: true,
      });
    }
    const sourceRecordsByIdentity = new Map<string, Readonly<{
      id: string;
      record_kind: "catalog" | "pull" | "trade";
      record_discriminator: string;
    }>>();
    for (const batch of batches(uniqueIdentities)) {
      const rows = await transaction.source_record_identities.findMany({
        where: {
          organization_id: scope.organizationId,
          source_instance_id: scope.sourceInstanceId,
          OR: batch.map((input) => ({
            record_id_scope_key: input.recordIdScopeKey,
            provider_record_id: input.providerRecordId,
          })),
        },
        select: {
          id: true,
          record_id_scope_key: true,
          provider_record_id: true,
          record_kind: true,
          record_discriminator: true,
        },
      });
      for (const row of rows) {
        sourceRecordsByIdentity.set(sourceRecordIdentityKey({
          recordIdScopeKey: row.record_id_scope_key,
          providerRecordId: row.provider_record_id,
        }), row);
      }
    }

    const resolved = prepared.map((item) => {
      const sourceRecord = sourceRecordsByIdentity.get(
        sourceRecordIdentityKey(item.input),
      );
      if (!sourceRecord) {
        throw new Error("Source record identity insert returned no identity.");
      }
      return { ...item, sourceRecord };
    });
    const ready = resolved.filter(({ input, sourceRecord }) =>
      sourceRecord.record_kind === input.recordKind &&
      sourceRecord.record_discriminator === input.recordDiscriminator
    );
    const createdSemanticKeys = new Set<string>();
    for (const batch of batches(ready)) {
      const rows = batch.map(({ input, normalizedContent, normalizedContentHash, sourceRecord }) =>
        Prisma.sql`(
          ${input.organizationId}::uuid,
          ${sourceRecord.id}::uuid,
          ${input.effectiveSourceTime},
          ${input.normalizedContractVersion},
          ${input.hashVersion},
          ${normalizedContentHash},
          ${jsonValue(normalizedContent)}
        )`
      );
      const inserted = await transaction.$queryRaw<Array<{
        sourceRecordId: string;
        effectiveSourceTime: Date;
        normalizedContractVersion: string;
        hashVersion: string;
        normalizedContentHash: string;
      }>>(Prisma.sql`
        insert into public.source_semantic_observations (
          organization_id, source_record_id, effective_source_time,
          normalized_contract_version, hash_version, normalized_content_hash,
          normalized_content_json
        ) values ${Prisma.join(rows)}
        on conflict do nothing
        returning source_record_id as "sourceRecordId",
                  effective_source_time as "effectiveSourceTime",
                  normalized_contract_version as "normalizedContractVersion",
                  hash_version as "hashVersion",
                  normalized_content_hash as "normalizedContentHash"
      `);
      for (const row of inserted) {
        createdSemanticKeys.add(semanticObservationIdentityKey(row));
      }
    }

    const semanticObservationsByIdentity = new Map<string, string>();
    for (const batch of batches(ready)) {
      const identities = batch.map(({ input, normalizedContentHash, sourceRecord }) =>
        Prisma.sql`(
          ${sourceRecord.id}::uuid,
          ${input.effectiveSourceTime},
          ${input.normalizedContractVersion},
          ${input.hashVersion},
          ${normalizedContentHash}
        )`
      );
      const observations = await transaction.$queryRaw<Array<{
        id: string;
        sourceRecordId: string;
        effectiveSourceTime: Date;
        normalizedContractVersion: string;
        hashVersion: string;
        normalizedContentHash: string;
      }>>(Prisma.sql`
        select id,
               source_record_id as "sourceRecordId",
               effective_source_time as "effectiveSourceTime",
               normalized_contract_version as "normalizedContractVersion",
               hash_version as "hashVersion",
               normalized_content_hash as "normalizedContentHash"
        from public.source_semantic_observations
        where (
          source_record_id, effective_source_time, normalized_contract_version,
          hash_version, normalized_content_hash
        ) in (values ${Prisma.join(identities)})
      `);
      for (const observation of observations) {
        semanticObservationsByIdentity.set(
          semanticObservationIdentityKey(observation),
          observation.id,
        );
      }
    }

    const unclaimedCreatedKeys = new Set(createdSemanticKeys);
    return resolved.map(({ input, normalizedContentHash, sourceRecord }) => {
      if (
        sourceRecord.record_kind !== input.recordKind ||
        sourceRecord.record_discriminator !== input.recordDiscriminator
      ) {
        return {
          kind: "identity_conflict" as const,
          sourceRecordId: sourceRecord.id,
          semanticObservationId: null,
          reasonCode: "source_identity_conflict" as const,
        };
      }
      const key = semanticObservationIdentityKey({
        sourceRecordId: sourceRecord.id,
        effectiveSourceTime: input.effectiveSourceTime,
        normalizedContractVersion: input.normalizedContractVersion,
        hashVersion: input.hashVersion,
        normalizedContentHash,
      });
      const semanticObservationId = semanticObservationsByIdentity.get(key);
      if (!semanticObservationId) {
        throw new Error("Semantic observation conflict could not be resolved.");
      }
      return {
        kind: "ready" as const,
        sourceRecordId: sourceRecord.id,
        semanticObservationId,
        semanticObservationCreated: unclaimedCreatedKeys.delete(key),
      };
    });
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
    for (const batch of batches(inputs)) {
      await transaction.source_delivery_occurrences.createMany({
        data: batch.map(deliveryOccurrenceRow),
      });
    }
  }

  /**
   * Records bounded delivery batches and returns generated ids keyed by the
   * page's unique record index. Quarantine rows can therefore be bulk-written
   * later in the same transaction without a per-record round trip.
   */
  async recordDeliveryOccurrencesWithIdsInTransaction(
    transaction: PackscoutTransactionClient,
    inputs: readonly RecordDeliveryOccurrenceInput[],
  ): Promise<readonly RecordedDeliveryOccurrence[]> {
    for (const input of inputs) validateDeliveryOccurrenceInput(input);
    const recorded: RecordedDeliveryOccurrence[] = [];
    for (const batch of batches(inputs)) {
      const rows = batch.map((input) => Prisma.sql`(
        ${input.organizationId}::uuid,
        ${input.providerId}::uuid,
        ${input.sourceInstanceId}::uuid,
        ${input.sourceRevisionId}::uuid,
        ${input.runId}::uuid,
        ${input.pageId}::uuid,
        ${input.recordIndex},
        ${input.sourceRecordId === null
          ? Prisma.sql`null::uuid`
          : Prisma.sql`${input.sourceRecordId}::uuid`},
        ${input.semanticObservationId === null
          ? Prisma.sql`null::uuid`
          : Prisma.sql`${input.semanticObservationId}::uuid`},
        ${input.requestAttemptId}::uuid,
        ${input.sourceTypeKey},
        ${input.sourceAdapterVersion},
        ${input.normalizedContractVersion},
        ${input.mapperKey},
        ${input.mapperVersion},
        ${input.identityNamespaceKey},
        ${input.cursorCodecVersion},
        ${input.cursorGeneration},
        ${input.connectionHealthGeneration},
        ${input.supervisorEpochId}::uuid,
        ${input.connectionProfileId}::uuid,
        ${input.connectionRevisionId}::uuid,
        ${input.collectedAt},
        ${input.nativeEvidenceReference},
        cast(${input.disposition} as public.source_delivery_disposition),
        ${input.disposition === "quarantined" ? input.reasonCode : null}
      )`);
      recorded.push(
        ...(await transaction.$queryRaw<Array<{
          occurrenceId: bigint;
          recordIndex: number;
        }>>(Prisma.sql`
          insert into public.source_delivery_occurrences (
            organization_id, provider_id, source_instance_id,
            source_revision_id, run_id, page_id, record_index,
            source_record_id, semantic_observation_id, request_attempt_id,
            source_type_key, source_adapter_version,
            normalized_contract_version, mapper_key, mapper_version,
            identity_namespace_key, cursor_codec_version, cursor_generation,
            connection_health_generation, supervisor_epoch_id,
            connection_profile_id, connection_revision_id, collected_at,
            native_evidence_reference, disposition, reason_code
          ) values ${Prisma.join(rows)}
          returning id as "occurrenceId", record_index as "recordIndex"
        `)),
      );
    }
    return recorded;
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
    cursor_codec_version: input.cursorCodecVersion,
    cursor_generation: input.cursorGeneration,
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
