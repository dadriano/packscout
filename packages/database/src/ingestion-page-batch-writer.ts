import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { PackscoutTransactionClient } from "./database.ts";
import type {
  CanonicalProjectionInput,
  CommitPageInput,
  RawEvidencePolicy,
  SourceRecordKind,
} from "./pipeline-types.ts";
import {
  allocatePublicChangeCauses,
  canonicalCatalogPlatformKeys,
  canonicalPublicEntityKey,
  relationshipPublicEntityKey,
  type PublicCatalogImpact,
  type PublicChangeKind,
} from "./public-change-settlement-repository.ts";
import { persistNormalizedHeatObservationsForCanonicalWrites } from "./normalized-heat-observation-repository.ts";
import {
  providerStreamContentHashV2,
  providerStreamRecordIdentityHashV2,
  providerStreamSourceFactsHashV2,
} from "./provider-stream-write-policy.ts";
import {
  assertCanonicalActorDataSafe,
  hashJson,
  pseudonymizeProviderActor,
} from "./security.ts";
import {
  databaseSafeProtectedJsonEvidence,
  databaseSafeQuarantineExternalId,
} from "./protected-json-evidence.ts";

const maximumRowsPerWrite = 500;
const catalogProjectionRecordKinds = new Set<CanonicalProjectionInput["recordKind"]>([
  "platform",
  "pack",
  "catalog_asset",
  "ev_input",
  "estimated_ev",
]);

function canonicalProjectionCatalogImpact(
  projection: CanonicalProjectionInput,
): PublicCatalogImpact {
  return catalogProjectionRecordKinds.has(projection.recordKind)
    ? { kind: "catalog", providerPlatformKeys: [projection.platformKey] }
    : { kind: "none" };
}

function relationshipCatalogImpact(
  sourceRecordKind: CanonicalProjectionInput["recordKind"],
  sourcePlatformKey: string,
  targetPlatformKey: string,
): PublicCatalogImpact {
  if (!catalogProjectionRecordKinds.has(sourceRecordKind)) {
    return { kind: "none" };
  }
  return {
    kind: "catalog",
    providerPlatformKeys: canonicalCatalogPlatformKeys([
      sourcePlatformKey,
      targetPlatformKey,
    ]),
  };
}

function assertCanonicalWriteTransaction(
  database: PackscoutTransactionClient,
): void {
  if ("$transaction" in (database as unknown as Record<string, unknown>)) {
    throw new TypeError(
      "Canonical projection writes require the caller's active database transaction.",
    );
  }
}

interface CanonicalProjectionWriteInput {
  readonly organizationId: string;
  readonly providerId: string;
  readonly configRevisionId: string;
  readonly sourceRecordId: string;
  readonly projection: CanonicalProjectionInput;
  readonly projectionIndex: number;
  readonly acceptedAt: Date;
  readonly publicChangeKind: PublicChangeKind;
}

export interface CanonicalProjectionWriteResult {
  readonly revisionId: string;
  readonly created: boolean;
  readonly publicChangeSequence: bigint;
}

interface PreparedSourceRecord {
  readonly sourcePosition: number;
  readonly recordIndex: number;
  readonly input: CommitPageInput["records"][number];
  readonly contentHash: string;
  readonly recordIdentityHash: string;
  readonly sourceFactsHash: string;
  readonly identityKey: string;
}

interface ResolvedSourceRecord extends PreparedSourceRecord {
  readonly sourceRecordId: string | null;
  readonly created: boolean;
  readonly conflictReasonCode: "CATALOG_IDENTITY_CONFLICT" | "IMMUTABLE_EVENT_CONFLICT" | null;
}

interface CanonicalEntityIdentity {
  readonly platformKey: string;
  readonly recordKind: CanonicalProjectionInput["recordKind"];
  readonly externalId: string;
}

interface CanonicalEntityRecord extends CanonicalEntityIdentity {
  readonly id: string;
  readonly publicChangeSequence: bigint | null;
}

interface PreparedCanonicalProjection extends CanonicalProjectionWriteInput {
  readonly entityId: string;
  readonly contentHash: string;
  readonly provenance: Record<string, unknown>;
  readonly provenanceHash: string;
}

interface ExistingCanonicalRevision {
  readonly id: string;
  readonly entityId: string;
  readonly revisionNumber: number;
  readonly contentHash: string;
  readonly provenanceHash: string;
  publicChangeSequence: bigint;
}

interface CanonicalRevisionInsert extends ExistingCanonicalRevision {
  readonly organizationId: string;
  readonly sourceRecordId: string;
  readonly content: Record<string, unknown>;
  readonly provenance: Record<string, unknown>;
  readonly actorKey: string | null;
  readonly sourceUpdatedAt: Date;
  readonly sourceCollectedAt: Date;
  readonly acceptedAt: Date;
}

interface ProjectionLinkInsert {
  readonly sourceRecordId: string;
  readonly canonicalRevisionId: string;
  readonly organizationId: string;
  readonly projectionIndex: number;
  readonly createdAt: Date;
}

interface RelationshipInsert {
  readonly organizationId: string;
  readonly sourceEntityId: string;
  readonly sourcePlatformKey: string;
  readonly sourceRecordKind: CanonicalProjectionInput["recordKind"];
  readonly relationshipKind: string;
  readonly targetPlatformKey: string;
  readonly targetRecordKind: CanonicalProjectionInput["recordKind"];
  readonly targetExternalId: string | null;
  readonly targetEntityId: string | null;
  createdPublicChangeSequence: bigint;
  resolvedPublicChangeSequence: bigint | null;
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
}

interface SourceOutcomeInsert {
  readonly organizationId: string;
  readonly runId: string;
  readonly pageId: string;
  readonly sourceRecordId: string | null;
  readonly recordKind: SourceRecordKind;
  readonly recordIndex: number;
  readonly externalId: string | null;
  readonly outcome: "accepted" | "duplicate" | "quarantined";
  readonly reasonCode: string | null;
  readonly createdAt: Date;
}

interface QuarantineInsert {
  readonly organizationId: string;
  readonly providerId: string;
  readonly runId: string;
  readonly pageId: string;
  readonly sourceRecordId: string | null;
  readonly recordKind: SourceRecordKind;
  readonly recordIndex: number;
  readonly externalId: string | null;
  readonly reasonCode: string;
  readonly fieldPath: string | null;
  readonly sanitizedSummary: string;
  readonly payload: unknown;
  readonly hasStandalonePayload: boolean;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export interface PageRecordBatchResult {
  readonly accepted: number;
  readonly duplicate: number;
  readonly quarantined: number;
  readonly newCanonicalRevisions: number;
  readonly createdCanonicalProjections: readonly {
    projection: CanonicalProjectionInput;
    publicChangeSequence: bigint;
  }[];
}

function batches<T>(values: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += maximumRowsPerWrite) {
    result.push(values.slice(index, index + maximumRowsPerWrite));
  }
  return result;
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function jsonValue(value: unknown): Prisma.Sql {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("Persistence JSON values must be serializable.");
  }
  return Prisma.sql`cast(${serialized} as jsonb)`;
}

function uuid(value: string): Prisma.Sql {
  return Prisma.sql`cast(${value} as uuid)`;
}

function sourceFactsKey(input: {
  recordKind: SourceRecordKind;
  externalId: string;
  sourceFactsHash: string;
}): string {
  return [
    input.recordKind,
    input.externalId,
    input.sourceFactsHash,
  ].join("\u0000");
}

function stableSourceKey(input: {
  recordKind: SourceRecordKind;
  externalId: string;
}): string {
  return [input.recordKind, input.externalId].join("\u0000");
}

function stableSourceLockKey(
  input: Pick<CommitPageInput, "organizationId" | "providerId">,
  record: Pick<PreparedSourceRecord["input"], "recordKind" | "externalId">,
): string {
  return createHash("sha256")
    .update(JSON.stringify([
      input.organizationId,
      input.providerId,
      record.recordKind,
      record.externalId,
    ]))
    .digest()
    .readBigInt64BE(0)
    .toString();
}

function compareAdvisoryKeys(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function canonicalIdentityKey(identity: CanonicalEntityIdentity): string {
  return [identity.platformKey, identity.recordKind, identity.externalId].join(
    "\u0000",
  );
}

function canonicalRevisionKey(input: {
  entityId: string;
  contentHash: string;
  provenanceHash: string;
}): string {
  return [input.entityId, input.contentHash, input.provenanceHash].join("\u0000");
}

function relationshipIdentityKey(input: {
  sourceEntityId: string;
  relationshipKind: string;
  targetPlatformKey: string;
  targetRecordKind: CanonicalProjectionInput["recordKind"];
  targetExternalId: string | null;
}): string {
  return [
    input.sourceEntityId,
    input.relationshipKind,
    input.targetPlatformKey,
    input.targetRecordKind,
    input.targetExternalId ?? "<null>",
  ].join("\u0000");
}

async function resolveSourceRecords(
  database: PackscoutTransactionClient,
  input: CommitPageInput,
  prepared: readonly PreparedSourceRecord[],
  pageId: string,
  expiresAt: Date,
): Promise<ResolvedSourceRecord[]> {
  if (prepared.length === 0) return [];
  interface ExistingSource {
    readonly id: string;
    readonly recordKind: SourceRecordKind;
    readonly externalId: string;
    readonly recordIdentityHash: string;
    readonly sourceFactsHash: string;
  }
  const stableIdentities = new Map<string, Pick<PreparedSourceRecord["input"], "recordKind" | "externalId">>();
  for (const record of prepared) {
    stableIdentities.set(stableSourceKey(record.input), record.input);
  }
  const stableLockKeys = [...stableIdentities.values()]
    .map((record) => stableSourceLockKey(input, record))
    .sort(compareAdvisoryKeys);
  for (const batch of batches(stableLockKeys)) {
    await database.$queryRaw(Prisma.sql`
      select pg_advisory_xact_lock(lock_key)::text as lock_result
      from (
        select distinct lock_key
        from unnest(array[${Prisma.join(batch)}]::bigint[]) as requested(lock_key)
        order by lock_key
      ) as stable_locks
    `);
  }
  const existingByStableIdentity = new Map<string, ExistingSource[]>();
  for (const batch of batches([...stableIdentities.values()])) {
    const identities = batch.map((record) => Prisma.sql`(
      cast(${record.recordKind} as public.source_record_kind),
      ${record.externalId}
    )`);
    const existing = await database.$queryRaw<ExistingSource[]>(Prisma.sql`
      select
        id,
        record_kind::text as "recordKind",
        external_id as "externalId",
        record_identity_hash as "recordIdentityHash",
        source_facts_hash as "sourceFactsHash"
      from public.source_records
      where organization_id = ${uuid(input.organizationId)}
        and provider_id = ${uuid(input.providerId)}
        and (record_kind, external_id) in (values ${Prisma.join(identities)})
      order by created_at, id
    `);
    for (const row of existing) {
      const key = stableSourceKey(row);
      const values = existingByStableIdentity.get(key) ?? [];
      values.push(row);
      existingByStableIdentity.set(key, values);
    }
  }

  const decisions: ResolvedSourceRecord[] = [];
  const recordsToCreate = new Map<string, PreparedSourceRecord>();
  for (const record of prepared) {
    const stableKey = stableSourceKey(record.input);
    const existing = existingByStableIdentity.get(stableKey) ?? [];
    const duplicate = existing.find(
      (candidate) => candidate.sourceFactsHash === record.sourceFactsHash,
    );
    if (duplicate) {
      decisions.push({
        ...record,
        sourceRecordId: duplicate.id,
        created: false,
        conflictReasonCode: null,
      });
      continue;
    }
    if (existing.length > 0) {
      if (record.input.recordKind !== "catalog") {
        decisions.push({
          ...record,
          sourceRecordId: null,
          created: false,
          conflictReasonCode: "IMMUTABLE_EVENT_CONFLICT",
        });
        continue;
      }
      if (
        existing.every(
          (candidate) => candidate.recordIdentityHash !== record.recordIdentityHash,
        )
      ) {
        decisions.push({
          ...record,
          sourceRecordId: null,
          created: false,
          conflictReasonCode: "CATALOG_IDENTITY_CONFLICT",
        });
        continue;
      }
    }
    const pending = recordsToCreate.get(record.identityKey);
    if (pending) {
      decisions.push({
        ...record,
        sourceRecordId: null,
        created: false,
        conflictReasonCode: null,
      });
      continue;
    }
    recordsToCreate.set(record.identityKey, record);
    existing.push({
      id: "",
      recordKind: record.input.recordKind,
      externalId: record.input.externalId,
      recordIdentityHash: record.recordIdentityHash,
      sourceFactsHash: record.sourceFactsHash,
    });
    existingByStableIdentity.set(stableKey, existing);
    decisions.push({
      ...record,
      sourceRecordId: null,
      created: true,
      conflictReasonCode: null,
    });
  }

  const uniqueRecords = [...recordsToCreate.values()].sort((left, right) =>
    compareKeys(left.identityKey, right.identityKey),
  );
  for (const batch of batches(uniqueRecords)) {
    const rows = batch.map((record) => Prisma.sql`(
      ${uuid(input.organizationId)},
      ${uuid(input.providerId)},
      ${uuid(input.runId)},
      ${uuid(pageId)},
      cast(${record.input.recordKind} as public.source_record_kind),
      ${record.input.externalId},
      ${record.input.sourceTime},
      ${record.input.collectedAt},
      ${jsonValue(databaseSafeProtectedJsonEvidence(record.input.payload))},
      ${record.contentHash},
      ${record.recordIdentityHash},
      ${record.sourceFactsHash},
      ${expiresAt},
      ${input.committedAt}
    )`);
    await database.$executeRaw(Prisma.sql`
      insert into public.source_records (
        organization_id, provider_id, first_run_id, first_page_id,
        record_kind, external_id, source_time, collected_at, payload_json,
        content_hash, record_identity_hash, source_facts_hash, expires_at, created_at
      )
      values ${Prisma.join(rows)}
      on conflict do nothing
    `);
  }

  const resolvedByIdentity = new Map<string, string>();
  for (const batch of batches(uniqueRecords)) {
    const identities = batch.map((record) => Prisma.sql`(
      cast(${record.input.recordKind} as public.source_record_kind),
      ${record.input.externalId},
      ${record.sourceFactsHash}
    )`);
    const resolved = await database.$queryRaw<Array<{
      id: string;
      recordKind: SourceRecordKind;
      externalId: string;
      sourceFactsHash: string;
    }>>(Prisma.sql`
      select
      id,
      record_kind::text as "recordKind",
      external_id as "externalId",
      source_facts_hash as "sourceFactsHash"
      from public.source_records
      where organization_id = ${uuid(input.organizationId)}
        and provider_id = ${uuid(input.providerId)}
        and (record_kind, external_id, source_facts_hash) in (
          values ${Prisma.join(identities)}
        )
    `);
    for (const record of resolved) {
      resolvedByIdentity.set(sourceFactsKey(record), record.id);
    }
  }
  const unresolved = decisions.filter(
    (record) =>
      !record.conflictReasonCode && !resolvedByIdentity.has(record.identityKey),
  );
  const reconciledByStableIdentity = new Map<string, ExistingSource[]>();
  for (const batch of batches(unresolved)) {
    const identities = batch.map((record) => Prisma.sql`(
      cast(${record.input.recordKind} as public.source_record_kind),
      ${record.input.externalId}
    )`);
    const reconciled = await database.$queryRaw<ExistingSource[]>(Prisma.sql`
      select
        id,
        record_kind::text as "recordKind",
        external_id as "externalId",
        record_identity_hash as "recordIdentityHash",
        source_facts_hash as "sourceFactsHash"
      from public.source_records
      where organization_id = ${uuid(input.organizationId)}
        and provider_id = ${uuid(input.providerId)}
        and (record_kind, external_id) in (values ${Prisma.join(identities)})
    `);
    for (const row of reconciled) {
      const key = stableSourceKey(row);
      const values = reconciledByStableIdentity.get(key) ?? [];
      values.push(row);
      reconciledByStableIdentity.set(key, values);
    }
  }
  return decisions.map((record) => {
    if (record.conflictReasonCode) return record;
    const sourceRecordId = resolvedByIdentity.get(record.identityKey);
    if (sourceRecordId) return { ...record, sourceRecordId };
    const stable = reconciledByStableIdentity.get(stableSourceKey(record.input)) ?? [];
    const concurrentDuplicate = stable.find(
      (candidate) => candidate.sourceFactsHash === record.sourceFactsHash,
    );
    if (concurrentDuplicate) {
      return {
        ...record,
        sourceRecordId: concurrentDuplicate.id,
        created: false,
      };
    }
    if (stable.length > 0) {
      return {
        ...record,
        sourceRecordId: null,
        created: false,
        conflictReasonCode:
          record.input.recordKind === "catalog"
            ? "CATALOG_IDENTITY_CONFLICT"
            : "IMMUTABLE_EVENT_CONFLICT",
      };
    }
    throw new Error("Source record conflict could not be resolved.");
  });
}

async function loadCanonicalEntities(
  database: PackscoutTransactionClient,
  organizationId: string,
  identities: readonly CanonicalEntityIdentity[],
  acceptedAt: Date,
): Promise<Map<string, CanonicalEntityRecord>> {
  const uniqueByIdentity = new Map<string, CanonicalEntityIdentity>();
  for (const identity of identities) {
    uniqueByIdentity.set(canonicalIdentityKey(identity), identity);
  }
  const uniqueIdentities = [...uniqueByIdentity.values()].sort((left, right) =>
    compareKeys(canonicalIdentityKey(left), canonicalIdentityKey(right)),
  );
  if (uniqueIdentities.length === 0) return new Map();

  for (const batch of batches(uniqueIdentities)) {
    const rows = batch.map((identity) => Prisma.sql`(
      ${uuid(organizationId)},
      ${identity.platformKey},
      cast(${identity.recordKind} as public.canonical_record_kind),
      ${identity.externalId},
      ${acceptedAt},
      ${acceptedAt}
    )`);
    await database.$executeRaw(Prisma.sql`
      insert into public.canonical_entities (
        organization_id, platform_key, record_kind, external_id, created_at, updated_at
      )
      values ${Prisma.join(rows)}
      on conflict do nothing
    `);
  }

  const entitiesByIdentity = new Map<string, CanonicalEntityRecord>();
  for (const batch of batches(uniqueIdentities)) {
    const rows = batch.map((identity) => Prisma.sql`(
      ${identity.platformKey},
      cast(${identity.recordKind} as public.canonical_record_kind),
      ${identity.externalId}
    )`);
    const entities = await database.$queryRaw<CanonicalEntityRecord[]>(Prisma.sql`
      select
        entity.id,
        entity.platform_key as "platformKey",
        entity.record_kind::text as "recordKind",
        entity.external_id as "externalId",
        revision.public_change_sequence as "publicChangeSequence"
      from public.canonical_entities as entity
      left join public.canonical_revisions as revision
        on revision.id = entity.current_revision_id
      where entity.organization_id = ${uuid(organizationId)}
        and (entity.platform_key, entity.record_kind, entity.external_id) in (
          values ${Prisma.join(rows)}
        )
      order by entity.platform_key, entity.record_kind, entity.external_id
      for update of entity
    `);
    for (const entity of entities) {
      entitiesByIdentity.set(canonicalIdentityKey(entity), entity);
    }
  }
  if (entitiesByIdentity.size !== uniqueIdentities.length) {
    throw new Error("Canonical entity insert returned no identity.");
  }
  return entitiesByIdentity;
}

async function loadRelationshipTargets(
  database: PackscoutTransactionClient,
  organizationId: string,
  identities: readonly CanonicalEntityIdentity[],
  knownEntities: ReadonlyMap<string, CanonicalEntityRecord>,
): Promise<Map<string, CanonicalEntityRecord>> {
  const targets = new Map(knownEntities);
  const missingByIdentity = new Map<string, CanonicalEntityIdentity>();
  for (const identity of identities) {
    const key = canonicalIdentityKey(identity);
    if (!targets.has(key)) missingByIdentity.set(key, identity);
  }
  for (const batch of batches([...missingByIdentity.values()])) {
    const rows = batch.map((identity) => Prisma.sql`(
      ${identity.platformKey},
      cast(${identity.recordKind} as public.canonical_record_kind),
      ${identity.externalId}
    )`);
    const records = await database.$queryRaw<CanonicalEntityRecord[]>(Prisma.sql`
      select
        entity.id,
        entity.platform_key as "platformKey",
        entity.record_kind::text as "recordKind",
        entity.external_id as "externalId",
        revision.public_change_sequence as "publicChangeSequence"
      from public.canonical_entities as entity
      join public.canonical_revisions as revision
        on revision.id = entity.current_revision_id
      where entity.organization_id = ${uuid(organizationId)}
        and (entity.platform_key, entity.record_kind, entity.external_id) in (
          values ${Prisma.join(rows)}
        )
    `);
    for (const record of records) {
      targets.set(canonicalIdentityKey(record), record);
    }
  }
  return targets;
}

export async function writeCanonicalProjectionBatch(
  database: PackscoutTransactionClient,
  policy: RawEvidencePolicy,
  inputs: readonly CanonicalProjectionWriteInput[],
): Promise<CanonicalProjectionWriteResult[]> {
  assertCanonicalWriteTransaction(database);
  if (inputs.length === 0) return [];
  const scope = inputs[0]!;
  if (
    inputs.some(
      (input) =>
        input.organizationId !== scope.organizationId ||
        input.providerId !== scope.providerId ||
        input.configRevisionId !== scope.configRevisionId ||
        input.publicChangeKind !== scope.publicChangeKind ||
        input.acceptedAt.getTime() !== scope.acceptedAt.getTime(),
    )
  ) {
    throw new Error(
      "Canonical projection batches cannot span tenant, provider, configuration, or commit scopes.",
    );
  }
  const providerRows = await database.$queryRaw<Array<{ platformKey: string }>>(
    Prisma.sql`
      select platform_key as "platformKey"
      from public.provider_sources
      where organization_id = ${uuid(scope.organizationId)}
        and id = ${uuid(scope.providerId)}
      for share
    `,
  );
  const providerPlatformKey = providerRows[0]?.platformKey;
  if (
    !providerPlatformKey ||
    inputs.some(
      ({ projection }) => projection.platformKey !== providerPlatformKey,
    )
  ) {
    throw new Error("Canonical projection provider scope is invalid.");
  }
  const relationshipPlatformKeys = [
    ...new Set(
      inputs.flatMap(({ projection }) =>
        (projection.relationships ?? []).map(
          ({ targetPlatformKey }) => targetPlatformKey,
        ),
      ),
    ),
  ].sort();
  if (relationshipPlatformKeys.length > 0) {
    const registeredTargets = await database.$queryRaw<
      Array<{ platformKey: string }>
    >(Prisma.sql`
      select platform_key as "platformKey"
      from public.provider_sources
      where organization_id = ${uuid(scope.organizationId)}
        and platform_key in (${Prisma.join(relationshipPlatformKeys)})
      order by platform_key collate "C"
      for share
    `);
    if (
      registeredTargets.length !== relationshipPlatformKeys.length ||
      registeredTargets.some(
        ({ platformKey }, index) =>
          platformKey !== relationshipPlatformKeys[index],
      )
    ) {
      throw new Error("Canonical relationship provider scope is invalid.");
    }
  }
  for (const input of inputs) {
    assertCanonicalActorDataSafe(input.projection.content);
  }
  const entitiesByIdentity = await loadCanonicalEntities(
    database,
    scope.organizationId,
    inputs.map(({ projection }) => projection),
    scope.acceptedAt,
  );
  const prepared: PreparedCanonicalProjection[] = inputs.map((input) => {
    const entity = entitiesByIdentity.get(canonicalIdentityKey(input.projection));
    if (!entity) throw new Error("Canonical entity insert returned no identity.");
    const provenance = {
      ...(input.projection.provenance ?? {}),
      configRevisionId: input.configRevisionId,
      providerId: input.providerId,
      sourceRecordId: input.sourceRecordId,
    };
    return {
      ...input,
      entityId: entity.id,
      contentHash: hashJson(input.projection.content),
      provenance,
      provenanceHash: hashJson(provenance),
    };
  });

  const entityIds = [...new Set(prepared.map(({ entityId }) => entityId))];
  const existingRevisions: ExistingCanonicalRevision[] = [];
  for (const batch of batches(entityIds)) {
    existingRevisions.push(
      ...(await database.$queryRaw<ExistingCanonicalRevision[]>(Prisma.sql`
        select
          id,
          entity_id as "entityId",
          revision_number as "revisionNumber",
          content_hash as "contentHash",
          provenance_hash as "provenanceHash",
          public_change_sequence as "publicChangeSequence"
        from public.canonical_revisions
        where entity_id in (${Prisma.join(batch.map(uuid))})
      `)),
    );
  }
  const revisionsByIdentity = new Map(
    existingRevisions.map((revision) => [canonicalRevisionKey(revision), revision]),
  );
  const latestRevisionNumberByEntity = new Map<string, number>();
  for (const revision of existingRevisions) {
    latestRevisionNumberByEntity.set(
      revision.entityId,
      Math.max(
        latestRevisionNumberByEntity.get(revision.entityId) ?? 0,
        revision.revisionNumber,
      ),
    );
  }

  const revisionsToInsert: CanonicalRevisionInsert[] = [];
  const projectionByRevisionId = new Map<string, PreparedCanonicalProjection>();
  const currentRevisionByEntity = new Map<string, string>();
  let results: CanonicalProjectionWriteResult[] = [];
  for (const projection of prepared) {
    const revisionKey = canonicalRevisionKey(projection);
    const existing = revisionsByIdentity.get(revisionKey);
    if (existing) {
      results.push({
        revisionId: existing.id,
        created: false,
        publicChangeSequence: existing.publicChangeSequence,
      });
      continue;
    }
    const revisionId = randomUUID();
    const revisionNumber =
      (latestRevisionNumberByEntity.get(projection.entityId) ?? 0) + 1;
    latestRevisionNumberByEntity.set(projection.entityId, revisionNumber);
    const revision: CanonicalRevisionInsert = {
      id: revisionId,
      organizationId: projection.organizationId,
      entityId: projection.entityId,
      revisionNumber,
      sourceRecordId: projection.sourceRecordId,
      content: projection.projection.content,
      contentHash: projection.contentHash,
      provenance: projection.provenance,
      provenanceHash: projection.provenanceHash,
      publicChangeSequence: 0n,
      actorKey: projection.projection.sourceActorIdentifier
        ? pseudonymizeProviderActor({
            key: policy.actorPseudonymKey,
            platformKey: projection.projection.platformKey,
            sourceIdentifier: projection.projection.sourceActorIdentifier,
          })
        : null,
      sourceUpdatedAt: projection.projection.sourceUpdatedAt,
      sourceCollectedAt: projection.projection.sourceCollectedAt,
      acceptedAt: projection.acceptedAt,
    };
    revisionsByIdentity.set(revisionKey, revision);
    revisionsToInsert.push(revision);
    projectionByRevisionId.set(revisionId, projection);
    currentRevisionByEntity.set(projection.entityId, revisionId);
    results.push({ revisionId, created: true, publicChangeSequence: 0n });
  }

  const sequenceByRevisionId = new Map<string, bigint>();
  for (const revisionBatch of batches(revisionsToInsert)) {
    const causes = await allocatePublicChangeCauses(database, {
      organizationId: scope.organizationId,
      changes: revisionBatch.map((revision) => {
        const projection = projectionByRevisionId.get(revision.id);
        if (!projection) throw new Error("Canonical cause projection is missing.");
        return {
          changeKind: projection.publicChangeKind,
          entityKey: canonicalPublicEntityKey(revision.entityId),
          sourceKey: projection.projection.platformKey,
          sourceRevisionKey: projection.configRevisionId,
          metadata: { canonicalRevisionId: revision.id },
          occurredAt: projection.acceptedAt,
          catalogImpact: canonicalProjectionCatalogImpact(projection.projection),
        };
      }),
    });
    for (const [index, revision] of revisionBatch.entries()) {
      const sequence = causes[index]?.sequence;
      if (sequence === undefined) {
        throw new Error("Canonical public change sequence is missing.");
      }
      revision.publicChangeSequence = sequence;
      sequenceByRevisionId.set(revision.id, sequence);
    }
  }
  results = results.map((result) => ({
    ...result,
    publicChangeSequence:
      sequenceByRevisionId.get(result.revisionId) ?? result.publicChangeSequence,
  }));

  for (const [index, projection] of prepared.entries()) {
    const entity = entitiesByIdentity.get(canonicalIdentityKey(projection.projection));
    if (!entity) throw new Error("Canonical public entity is missing.");
    const sequence = results[index]?.publicChangeSequence;
    if (sequence === undefined) throw new Error("Canonical public sequence is missing.");
    entitiesByIdentity.set(canonicalIdentityKey(projection.projection), {
      ...entity,
      publicChangeSequence: sequence,
    });
  }

  for (const batch of batches(revisionsToInsert)) {
    const rows = batch.map((revision) => Prisma.sql`(
      ${uuid(revision.id)},
      ${uuid(revision.organizationId)},
      ${uuid(revision.entityId)},
      ${revision.revisionNumber},
      ${uuid(revision.sourceRecordId)},
      ${jsonValue(revision.content)},
      ${revision.contentHash},
      ${jsonValue(revision.provenance)},
      ${revision.provenanceHash},
      ${revision.actorKey},
      ${revision.sourceUpdatedAt},
      ${revision.sourceCollectedAt},
      ${revision.acceptedAt},
      ${revision.publicChangeSequence}
    )`);
    await database.$executeRaw(Prisma.sql`
      insert into public.canonical_revisions (
        id, organization_id, entity_id, revision_number, source_record_id,
        content_json, content_hash, provenance_json, provenance_hash, actor_key,
        source_updated_at, source_collected_at, accepted_at,
        public_change_sequence
      )
      values ${Prisma.join(rows)}
    `);
  }
  for (const batch of batches([...currentRevisionByEntity.entries()])) {
    const rows = batch.map(([entityId, revisionId]) =>
      Prisma.sql`(${uuid(entityId)}, ${uuid(revisionId)})`,
    );
    await database.$executeRaw(Prisma.sql`
      update public.canonical_entities as entity
      set current_revision_id = revisions.revision_id,
          updated_at = ${scope.acceptedAt}
      from (values ${Prisma.join(rows)}) as revisions(entity_id, revision_id)
      where entity.id = revisions.entity_id
        and entity.organization_id = ${uuid(scope.organizationId)}
    `);
  }

  const projectionLinks: ProjectionLinkInsert[] = prepared.map((projection, index) => ({
    sourceRecordId: projection.sourceRecordId,
    canonicalRevisionId: results[index]!.revisionId,
    organizationId: projection.organizationId,
    projectionIndex: projection.projectionIndex,
    createdAt: projection.acceptedAt,
  }));
  for (const batch of batches(projectionLinks)) {
    const rows = batch.map((link) => Prisma.sql`(
      ${uuid(link.sourceRecordId)},
      ${uuid(link.canonicalRevisionId)},
      ${uuid(link.organizationId)},
      ${link.projectionIndex},
      ${link.createdAt}
    )`);
    await database.$executeRaw(Prisma.sql`
      insert into public.source_record_projection_revisions (
        source_record_id, canonical_revision_id, organization_id,
        projection_index, created_at
      )
      values ${Prisma.join(rows)}
      on conflict do nothing
    `);
  }

  const relationshipTargets = prepared.flatMap(({ projection }) =>
    (projection.relationships ?? [])
      .filter(({ targetExternalId }) => targetExternalId !== null)
      .map((relationship) => ({
        platformKey: relationship.targetPlatformKey,
        recordKind: relationship.targetRecordKind,
        externalId: relationship.targetExternalId!,
      })),
  );
  const targetsByIdentity = await loadRelationshipTargets(
    database,
    scope.organizationId,
    relationshipTargets,
    entitiesByIdentity,
  );
  const proposedRelationships = prepared.flatMap((projection) => {
    const sourceEntity = entitiesByIdentity.get(
      canonicalIdentityKey(projection.projection),
    );
    if (!sourceEntity) throw new Error("Canonical relationship source is missing.");
    return (projection.projection.relationships ?? []).map((relationship) => {
      const target = relationship.targetExternalId
        ? targetsByIdentity.get(
            canonicalIdentityKey({
              platformKey: relationship.targetPlatformKey,
              recordKind: relationship.targetRecordKind,
              externalId: relationship.targetExternalId,
            }),
          )
        : undefined;
      return {
        organizationId: projection.organizationId,
        sourceEntityId: sourceEntity.id,
        sourcePlatformKey: sourceEntity.platformKey,
        sourceRecordKind: sourceEntity.recordKind,
        relationshipKind: relationship.relationshipKind,
        targetPlatformKey: relationship.targetPlatformKey,
        targetRecordKind: relationship.targetRecordKind,
        targetExternalId: relationship.targetExternalId,
        targetEntityId: target?.id ?? null,
        createdPublicChangeSequence: 0n,
        resolvedPublicChangeSequence: null,
        createdAt: projection.acceptedAt,
        resolvedAt: target ? projection.acceptedAt : null,
      };
    });
  });
  const proposedByIdentity = new Map<string, RelationshipInsert>();
  for (const relationship of proposedRelationships) {
    proposedByIdentity.set(relationshipIdentityKey(relationship), relationship);
  }
  const existingRelationshipKeys = new Set<string>();
  const sourceEntityIds = [
    ...new Set([...proposedByIdentity.values()].map(({ sourceEntityId }) => sourceEntityId)),
  ];
  for (const batch of batches(sourceEntityIds)) {
    const existing = await database.$queryRaw<Array<{
      sourceEntityId: string;
      relationshipKind: string;
      targetPlatformKey: string;
      targetRecordKind: CanonicalProjectionInput["recordKind"];
      targetExternalId: string | null;
    }>>(Prisma.sql`
      select source_entity_id as "sourceEntityId",
             relationship_kind as "relationshipKind",
             target_platform_key as "targetPlatformKey",
             target_record_kind::text as "targetRecordKind",
             target_external_id as "targetExternalId"
      from public.canonical_relationships
      where organization_id = ${uuid(scope.organizationId)}
        and source_entity_id in (${Prisma.join(batch.map(uuid))})
    `);
    existing.forEach((relationship) => {
      existingRelationshipKeys.add(relationshipIdentityKey(relationship));
    });
  }
  const relationships = [...proposedByIdentity.entries()]
    .filter(([key]) => !existingRelationshipKeys.has(key))
    .map(([, relationship]) => relationship);
  for (const relationshipBatch of batches(relationships)) {
    const relationshipCauses = await allocatePublicChangeCauses(database, {
      organizationId: scope.organizationId,
      changes: relationshipBatch.map((relationship) => ({
        changeKind: "relationship_resolution",
        entityKey: relationshipPublicEntityKey(relationship),
        sourceKey: relationship.targetPlatformKey,
        sourceRevisionKey: scope.configRevisionId,
        metadata: {
          relationshipState: relationship.targetEntityId ? "resolved" : "unresolved",
        },
        occurredAt: relationship.createdAt,
        catalogImpact: relationshipCatalogImpact(
          relationship.sourceRecordKind,
          relationship.sourcePlatformKey,
          relationship.targetPlatformKey,
        ),
      })),
    });
    relationshipBatch.forEach((relationship, index) => {
      const sequence = relationshipCauses[index]?.sequence;
      if (sequence === undefined) throw new Error("Relationship cause is missing.");
      relationship.createdPublicChangeSequence = sequence;
      relationship.resolvedPublicChangeSequence = relationship.targetEntityId
        ? sequence
        : null;
    });
  }
  for (const batch of batches(relationships)) {
    const rows = batch.map((relationship) => Prisma.sql`(
      ${uuid(relationship.organizationId)},
      ${uuid(relationship.sourceEntityId)},
      ${relationship.relationshipKind},
      ${relationship.targetPlatformKey},
      cast(${relationship.targetRecordKind} as public.canonical_record_kind),
      ${relationship.targetExternalId},
      ${relationship.targetEntityId ? uuid(relationship.targetEntityId) : Prisma.sql`null::uuid`},
      ${relationship.createdPublicChangeSequence},
      ${relationship.resolvedPublicChangeSequence},
      ${relationship.createdAt},
      ${relationship.resolvedAt}
    )`);
    await database.$executeRaw(Prisma.sql`
      insert into public.canonical_relationships (
        organization_id, source_entity_id, relationship_kind,
        target_platform_key, target_record_kind, target_external_id,
        target_entity_id, created_public_change_sequence,
        resolved_public_change_sequence, created_at, resolved_at
      )
      values ${Prisma.join(rows)}
      on conflict do nothing
    `);
  }

  for (const batch of batches([...entitiesByIdentity.values()])) {
    const rows = batch.map((entity) => {
      if (entity.publicChangeSequence === null) {
        throw new Error("Canonical relationship target cause is missing.");
      }
      return Prisma.sql`(
        ${entity.platformKey},
        cast(${entity.recordKind} as public.canonical_record_kind),
        ${entity.externalId},
        ${uuid(entity.id)},
        ${entity.publicChangeSequence}
      )`;
    });
    while (true) {
      const resolutionBatch = await database.$queryRaw<Array<{
        id: string;
        sourceEntityId: string;
        sourcePlatformKey: string;
        sourceRecordKind: CanonicalProjectionInput["recordKind"];
        relationshipKind: string;
        targetPlatformKey: string;
        targetRecordKind: CanonicalProjectionInput["recordKind"];
        targetExternalId: string;
        targetEntityId: string;
      }>>(Prisma.sql`
        select relationship.id,
               relationship.source_entity_id as "sourceEntityId",
               source_entity.platform_key as "sourcePlatformKey",
               source_entity.record_kind::text as "sourceRecordKind",
               relationship.relationship_kind as "relationshipKind",
               relationship.target_platform_key as "targetPlatformKey",
               relationship.target_record_kind::text as "targetRecordKind",
               relationship.target_external_id as "targetExternalId",
               targets.entity_id as "targetEntityId"
        from public.canonical_relationships as relationship
        join public.canonical_entities as source_entity
          on source_entity.id = relationship.source_entity_id
         and source_entity.organization_id = relationship.organization_id
        join (values ${Prisma.join(rows)})
          as targets(
            platform_key, record_kind, external_id, entity_id,
            public_change_sequence
          )
          on relationship.target_platform_key = targets.platform_key
         and relationship.target_record_kind = targets.record_kind
         and relationship.target_external_id = targets.external_id
        where relationship.organization_id = ${uuid(scope.organizationId)}
          and relationship.target_entity_id is null
        order by relationship.id
        for update of relationship
        limit ${maximumRowsPerWrite}
      `);
      if (resolutionBatch.length === 0) break;
      const resolutionCauses = await allocatePublicChangeCauses(database, {
        organizationId: scope.organizationId,
        changes: resolutionBatch.map((relationship) => ({
          changeKind: "relationship_resolution",
          entityKey: relationshipPublicEntityKey(relationship),
          sourceKey: relationship.targetPlatformKey,
          sourceRevisionKey: scope.configRevisionId,
          metadata: { relationshipState: "resolved" },
          occurredAt: scope.acceptedAt,
          catalogImpact: relationshipCatalogImpact(
            relationship.sourceRecordKind,
            relationship.sourcePlatformKey,
            relationship.targetPlatformKey,
          ),
        })),
      });
      const resolutionRows = resolutionBatch.map((relationship, index) => {
        const sequence = resolutionCauses[index]?.sequence;
        if (sequence === undefined) throw new Error("Resolution cause is missing.");
        return Prisma.sql`(
          ${uuid(relationship.id)}, ${uuid(relationship.targetEntityId)}, ${sequence}
        )`;
      });
      await database.$executeRaw(Prisma.sql`
        update public.canonical_relationships as relationship
        set target_entity_id = resolutions.target_entity_id,
            resolved_at = ${scope.acceptedAt},
            resolved_public_change_sequence = resolutions.public_change_sequence
        from (values ${Prisma.join(resolutionRows)})
          as resolutions(relationship_id, target_entity_id, public_change_sequence)
        where relationship.id = resolutions.relationship_id
          and relationship.organization_id = ${uuid(scope.organizationId)}
          and relationship.target_entity_id is null
      `);
    }
  }
  const heatSourceRevisions = revisionsToInsert.map((revision) => {
    const projection = projectionByRevisionId.get(revision.id);
    if (!projection) throw new Error("Canonical Heat source projection is missing.");
    return {
      revisionId: revision.id,
      entityId: revision.entityId,
      platformKey: projection.projection.platformKey,
      recordKind: projection.projection.recordKind,
      externalId: projection.projection.externalId,
      content: revision.content,
      publicChangeSequence: revision.publicChangeSequence,
      occurredAt: revision.sourceUpdatedAt,
    };
  });
  for (const revisionBatch of batches(heatSourceRevisions)) {
    await persistNormalizedHeatObservationsForCanonicalWrites(database, {
      organizationId: scope.organizationId,
      createdAt: scope.acceptedAt,
      revisions: revisionBatch,
    });
  }
  return results;
}

export async function persistPageRecordsInBatches(
  database: PackscoutTransactionClient,
  policy: RawEvidencePolicy,
  input: CommitPageInput,
  pageId: string,
  expiresAt: Date,
): Promise<PageRecordBatchResult> {
  assertCanonicalWriteTransaction(database);
  const prepared = input.records.map((record, sourcePosition) => {
    const contentHash = providerStreamContentHashV2(record.payload);
    const recordIdentityHash = providerStreamRecordIdentityHashV2(record.payload);
    const sourceFactsHash = providerStreamSourceFactsHashV2(record.payload);
    return {
      sourcePosition,
      recordIndex: record.recordIndex ?? sourcePosition,
      input: record,
      contentHash,
      recordIdentityHash,
      sourceFactsHash,
      identityKey: sourceFactsKey({ ...record, sourceFactsHash }),
    };
  });
  const resolved = await resolveSourceRecords(
    database,
    input,
    prepared,
    pageId,
    expiresAt,
  );

  const observationByIdentity = new Map<string, {
    sourceRecordId: string;
    organizationId: string;
    runId: string;
    pageId: string;
    observedAt: Date;
    sourceCollectedAt: Date;
  }>();
  for (const record of resolved) {
    if (!record.sourceRecordId) continue;
    const key = [record.sourceRecordId, input.runId, pageId].join("\u0000");
    observationByIdentity.set(key, {
      sourceRecordId: record.sourceRecordId,
      organizationId: input.organizationId,
      runId: input.runId,
      pageId,
      observedAt: input.committedAt,
      sourceCollectedAt: record.input.collectedAt,
    });
  }
  for (const batch of batches([...observationByIdentity.values()])) {
    const rows = batch.map((observation) => Prisma.sql`(
      ${uuid(observation.sourceRecordId)},
      ${uuid(observation.organizationId)},
      ${uuid(observation.runId)},
      ${uuid(observation.pageId)},
      ${observation.observedAt},
      ${observation.sourceCollectedAt}
    )`);
    await database.$executeRaw(Prisma.sql`
      insert into public.source_record_observations (
        source_record_id, organization_id, run_id, page_id, observed_at,
        source_collected_at
      )
      values ${Prisma.join(rows)}
      on conflict do nothing
    `);
  }

  const projectionWrites: Array<CanonicalProjectionWriteInput & {
    readonly sourcePosition: number;
  }> = [];
  for (const record of resolved) {
    if (record.input.quarantine || record.conflictReasonCode) continue;
    const sourceRecordId = record.sourceRecordId;
    if (!sourceRecordId) continue;
    for (const [projectionIndex, projection] of record.input.projections.entries()) {
      projectionWrites.push({
        organizationId: input.organizationId,
        providerId: input.providerId,
        configRevisionId: input.configRevisionId,
        sourceRecordId,
        projection,
        projectionIndex,
        acceptedAt: input.committedAt,
        publicChangeKind: "provider_projection" as const,
        sourcePosition: record.sourcePosition,
      });
    }
  }
  const canonicalResults = await writeCanonicalProjectionBatch(
    database,
    policy,
    projectionWrites,
  );
  const sourcePositionsWithNewRevisions = new Set<number>();
  const createdCanonicalProjections: Array<{
    projection: CanonicalProjectionInput;
    publicChangeSequence: bigint;
  }> = [];
  for (const [index, result] of canonicalResults.entries()) {
    if (!result.created) continue;
    sourcePositionsWithNewRevisions.add(projectionWrites[index]!.sourcePosition);
    createdCanonicalProjections.push({
      projection: projectionWrites[index]!.projection,
      publicChangeSequence: result.publicChangeSequence,
    });
  }

  let accepted = 0;
  let duplicate = 0;
  let quarantined = 0;
  const outcomeRows: SourceOutcomeInsert[] = [];
  const quarantineRows: QuarantineInsert[] = [];
  for (const record of resolved) {
    const reasonCode = record.conflictReasonCode ?? record.input.quarantine?.reasonCode ?? null;
    const outcome = reasonCode
      ? "quarantined"
      : sourcePositionsWithNewRevisions.has(record.sourcePosition) || record.created
        ? "accepted"
        : "duplicate";
    if (outcome === "accepted") accepted += 1;
    else if (outcome === "duplicate") duplicate += 1;
    else quarantined += 1;
    outcomeRows.push({
      organizationId: input.organizationId,
      runId: input.runId,
      pageId,
      sourceRecordId: record.sourceRecordId,
      recordKind: record.input.recordKind,
      recordIndex: record.recordIndex,
      externalId: record.input.externalId,
      outcome,
      reasonCode,
      createdAt: input.committedAt,
    });
    if (reasonCode) {
      const conflict = record.conflictReasonCode !== null;
      quarantineRows.push({
        organizationId: input.organizationId,
        providerId: input.providerId,
        runId: input.runId,
        pageId,
        sourceRecordId: record.sourceRecordId,
        recordKind: record.input.recordKind,
        recordIndex: record.recordIndex,
        externalId: record.input.externalId,
        reasonCode,
        fieldPath: conflict ? null : record.input.quarantine?.fieldPath ?? null,
        sanitizedSummary: conflict
          ? record.conflictReasonCode === "IMMUTABLE_EVENT_CONFLICT"
            ? "A pull or trade reused a stable source identity with different facts."
            : "A catalog record reused a stable source key with a different identity."
          : record.input.quarantine!.sanitizedSummary,
        payload: conflict ? record.input.payload : null,
        hasStandalonePayload: conflict,
        expiresAt,
        createdAt: input.committedAt,
      });
    }
  }
  for (const quarantine of input.quarantines ?? []) {
    quarantined += 1;
    quarantineRows.push({
      organizationId: input.organizationId,
      providerId: input.providerId,
      runId: input.runId,
      pageId,
      sourceRecordId: null,
      recordKind: quarantine.recordKind,
      recordIndex: quarantine.recordIndex,
      externalId: databaseSafeQuarantineExternalId(quarantine.externalId),
      reasonCode: quarantine.reasonCode,
      fieldPath: quarantine.fieldPath ?? null,
      sanitizedSummary: quarantine.sanitizedSummary,
      payload: quarantine.payload,
      hasStandalonePayload: true,
      expiresAt,
      createdAt: input.committedAt,
    });
    outcomeRows.push({
      organizationId: input.organizationId,
      runId: input.runId,
      pageId,
      sourceRecordId: null,
      recordKind: quarantine.recordKind,
      recordIndex: quarantine.recordIndex,
      externalId: databaseSafeQuarantineExternalId(quarantine.externalId),
      outcome: "quarantined",
      reasonCode: quarantine.reasonCode,
      createdAt: input.committedAt,
    });
  }
  for (const batch of batches(outcomeRows)) {
    const rows = batch.map((outcome) => Prisma.sql`(
      ${uuid(outcome.organizationId)},
      ${uuid(outcome.runId)},
      ${uuid(outcome.pageId)},
      ${outcome.sourceRecordId ? uuid(outcome.sourceRecordId) : Prisma.sql`null::uuid`},
      cast(${outcome.recordKind} as public.source_record_kind),
      ${outcome.recordIndex},
      ${outcome.externalId},
      cast(${outcome.outcome} as public.source_record_outcome),
      ${outcome.reasonCode},
      ${outcome.createdAt}
    )`);
    await database.$executeRaw(Prisma.sql`
      insert into public.source_record_outcomes (
        organization_id, run_id, page_id, source_record_id, record_kind,
        record_index, external_id, outcome, reason_code, created_at
      )
      values ${Prisma.join(rows)}
    `);
  }
  for (const batch of batches(quarantineRows)) {
    const rows = batch.map((quarantine) => Prisma.sql`(
      ${uuid(quarantine.organizationId)},
      ${uuid(quarantine.providerId)},
      ${uuid(quarantine.runId)},
      ${uuid(quarantine.pageId)},
      ${quarantine.sourceRecordId ? uuid(quarantine.sourceRecordId) : Prisma.sql`null::uuid`},
      cast(${quarantine.recordKind} as public.source_record_kind),
      ${quarantine.recordIndex},
      ${quarantine.externalId},
      ${quarantine.reasonCode},
      ${quarantine.fieldPath},
      ${quarantine.sanitizedSummary},
      ${quarantine.hasStandalonePayload
        ? jsonValue(databaseSafeProtectedJsonEvidence(quarantine.payload))
        : Prisma.sql`null::jsonb`},
      ${quarantine.expiresAt},
      ${quarantine.createdAt}
    )`);
    await database.$executeRaw(Prisma.sql`
      insert into public.quarantine_records (
        organization_id, provider_id, run_id, page_id, source_record_id,
        record_kind, record_index, external_id, reason_code, field_path,
        sanitized_summary, payload_json, expires_at, created_at
      )
      values ${Prisma.join(rows)}
    `);
  }
  return {
    accepted,
    duplicate,
    quarantined,
    newCanonicalRevisions: canonicalResults.filter(({ created }) => created).length,
    createdCanonicalProjections,
  };
}
