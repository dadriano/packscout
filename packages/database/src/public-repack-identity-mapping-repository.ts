import { MAX_PUBLIC_REPACKS_PER_RELEASE } from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import type { PackscoutTransactionClient } from "./database.ts";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuidV5Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface RegisterApprovedPublicRepackIdentityInput {
  readonly organizationId: string;
  readonly platformKey: string;
  readonly packExternalId: string;
  readonly publicRepackId: string;
  readonly approvedConfigurationKey: string;
  readonly publicChangeSequence: bigint;
  readonly approvedAt: Date;
}

export interface RegisterApprovedPublicRepackIdentityBatchInput {
  readonly organizationId: string;
  readonly approvedConfigurationKey: string;
  readonly publicChangeSequence: bigint;
  readonly approvedAt: Date;
  readonly mappings: readonly Readonly<{
    platformKey: string;
    packExternalId: string;
    publicRepackId: string;
  }>[];
}

export interface PublicRepackIdentityMappingRow {
  platformKey: string;
  packExternalId: string;
  publicRepackId: string;
  approvedConfigurationKey: string;
  publicChangeSequence: bigint;
  approvedAt: Date;
}

function uuid(value: string): Prisma.Sql {
  return Prisma.sql`cast(${value} as uuid)`;
}

function requireUuid(value: string, field: string): string {
  if (!uuidPattern.test(value)) throw new RangeError(`${field} is invalid.`);
  return value.toLowerCase();
}

function requireUuidV5(value: string, field: string): string {
  if (!uuidV5Pattern.test(value)) throw new RangeError(`${field} must be UUIDv5.`);
  return value.toLowerCase();
}

function requireBoundedText(
  value: string,
  field: string,
  maximumLength: number,
): string {
  if (value !== value.trim() || value.length < 1 || value.length > maximumLength) {
    throw new RangeError(`${field} is invalid.`);
  }
  return value;
}

function mappingKey(platformKey: string, packExternalId: string): string {
  return `${platformKey}\u0000${packExternalId}`;
}

function assertTransactionClient(database: PackscoutTransactionClient): void {
  if ("$transaction" in (database as unknown as Record<string, unknown>)) {
    throw new TypeError(
      "Public identity mapping writes require the caller's active database transaction.",
    );
  }
}

export class PublicRepackIdentityMappingConflictError extends Error {
  readonly code = "PUBLIC_REPACK_IDENTITY_MAPPING_CONFLICT" as const;

  constructor() {
    super("Approved public repack identity conflicts with an immutable mapping.");
    this.name = "PublicRepackIdentityMappingConflictError";
  }
}

export class PrismaPublicRepackIdentityMappingRepository {
  constructor(private readonly database: PackscoutTransactionClient) {
    assertTransactionClient(database);
  }

  async registerApprovedMapping(
    input: RegisterApprovedPublicRepackIdentityInput,
  ): Promise<Readonly<{ status: "created" | "existing" }>> {
    const result = await this.registerApprovedMappings({
      organizationId: input.organizationId,
      approvedConfigurationKey: input.approvedConfigurationKey,
      publicChangeSequence: input.publicChangeSequence,
      approvedAt: input.approvedAt,
      mappings: [{
        platformKey: input.platformKey,
        packExternalId: input.packExternalId,
        publicRepackId: input.publicRepackId,
      }],
    });
    return { status: result.created === 1 ? "created" : "existing" };
  }

  async registerApprovedMappings(
    input: RegisterApprovedPublicRepackIdentityBatchInput,
  ): Promise<Readonly<{ created: number; existing: number }>> {
    const organizationId = requireUuid(input.organizationId, "organizationId");
    const approvedConfigurationKey = requireBoundedText(
      input.approvedConfigurationKey,
      "approvedConfigurationKey",
      128,
    );
    if (input.publicChangeSequence < 1n) {
      throw new RangeError("publicChangeSequence is invalid.");
    }
    if (!Number.isFinite(input.approvedAt.getTime())) {
      throw new RangeError("approvedAt is invalid.");
    }
    if (input.mappings.length > MAX_PUBLIC_REPACKS_PER_RELEASE) {
      throw new RangeError("Approved public repack mapping batch is invalid.");
    }
    const mappings = input.mappings.map((mapping) => ({
      platformKey: requireBoundedText(mapping.platformKey, "platformKey", 128),
      packExternalId: requireBoundedText(
        mapping.packExternalId,
        "packExternalId",
        512,
      ),
      publicRepackId: requireUuidV5(mapping.publicRepackId, "publicRepackId"),
    }));
    if (
      new Set(mappings.map(({ platformKey, packExternalId }) =>
        mappingKey(platformKey, packExternalId))).size !== mappings.length
      || new Set(mappings.map(({ publicRepackId }) => publicRepackId)).size
        !== mappings.length
    ) {
      throw new PublicRepackIdentityMappingConflictError();
    }

    const causes = await this.database.$queryRaw<Array<{ valid: boolean }>>(Prisma.sql`
      select (change_kind = 'public_configuration') as valid
      from public.public_change_causes
      where organization_id = ${uuid(organizationId)}
        and sequence = ${input.publicChangeSequence}
      limit 1
    `);
    if (causes[0]?.valid !== true) {
      throw new RangeError("Mapping approval must reference a public configuration cause.");
    }
    if (mappings.length === 0) {
      return { created: 0, existing: 0 };
    }

    const requested = mappings.map((mapping) => Prisma.sql`(
      ${mapping.platformKey}, ${mapping.packExternalId},
      ${uuid(mapping.publicRepackId)}
    )`);
    const existingRows = await this.database.$queryRaw<
      PublicRepackIdentityMappingRow[]
    >(Prisma.sql`
      select distinct mapping.platform_key as "platformKey",
             mapping.pack_external_id as "packExternalId",
             mapping.public_repack_id::text as "publicRepackId",
             mapping.approved_configuration_key as "approvedConfigurationKey",
             mapping.public_change_sequence as "publicChangeSequence",
             mapping.approved_at as "approvedAt"
      from public.public_repack_identity_mappings as mapping
      join (values ${Prisma.join(requested)})
        as requested(platform_key, pack_external_id, public_repack_id)
        on (
          requested.platform_key = mapping.platform_key
          and requested.pack_external_id = mapping.pack_external_id
        ) or requested.public_repack_id = mapping.public_repack_id
      where mapping.organization_id = ${uuid(organizationId)}
    `);
    const requestedByIdentity = new Map(
      mappings.map((mapping) => [
        mappingKey(mapping.platformKey, mapping.packExternalId),
        mapping,
      ]),
    );
    const requestedByPublicId = new Map(
      mappings.map((mapping) => [mapping.publicRepackId, mapping]),
    );
    for (const existing of existingRows) {
      const byIdentity = requestedByIdentity.get(
        mappingKey(existing.platformKey, existing.packExternalId),
      );
      const byPublicId = requestedByPublicId.get(existing.publicRepackId);
      if (
        !byIdentity
        || !byPublicId
        || byIdentity !== byPublicId
        || byIdentity.publicRepackId !== existing.publicRepackId
      ) {
        throw new PublicRepackIdentityMappingConflictError();
      }
    }
    const existingIdentityKeys = new Set(
      existingRows.map(({ platformKey, packExternalId }) =>
        mappingKey(platformKey, packExternalId)),
    );
    const newMappings = mappings.filter(({ platformKey, packExternalId }) =>
      !existingIdentityKeys.has(mappingKey(platformKey, packExternalId)),
    );
    if (newMappings.length > 0) {
      const values = newMappings.map((mapping) => Prisma.sql`(
        ${uuid(organizationId)}, ${mapping.platformKey}, ${mapping.packExternalId},
        ${uuid(mapping.publicRepackId)}, ${approvedConfigurationKey},
        ${input.publicChangeSequence}, ${input.approvedAt}, ${input.approvedAt}
      )`);
      const inserted = await this.database.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        insert into public.public_repack_identity_mappings (
          organization_id, platform_key, pack_external_id, public_repack_id,
          approved_configuration_key, public_change_sequence, approved_at,
          created_at
        ) values ${Prisma.join(values)}
        on conflict do nothing
        returning public_repack_id::text as id
      `);
      if (inserted.length !== newMappings.length) {
        throw new PublicRepackIdentityMappingConflictError();
      }
    }
    return {
      created: newMappings.length,
      existing: mappings.length - newMappings.length,
    };
  }
}

/** Transaction-scoped adapter used by governed catalog configuration approval. */
export const prismaApprovedPublicRepackIdentityMaterializer = Object.freeze({
  async materializeApprovedMappings(
    database: PackscoutTransactionClient,
    input: RegisterApprovedPublicRepackIdentityBatchInput,
  ): Promise<Readonly<{ created: number; existing: number }>> {
    return await new PrismaPublicRepackIdentityMappingRepository(
      database,
    ).registerApprovedMappings(input);
  },
});
