import { Prisma as CentralPrisma } from
  "../prisma/generated/central/index.js";
import type { CentralQueryClient } from "./central-database.ts";

export interface CentralAdminProviderRecord {
  readonly id: string;
  readonly provider: string;
  readonly displayName: string;
  readonly state: "draft" | "active" | "disabled" | "archived";
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type CentralProviderImportAdmission =
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "source_unavailable" }>
  | Readonly<{
      kind: "revision_conflict";
      activeConfigVersionId: string;
    }>
  | Readonly<{
      kind: "ready";
      providerId: string;
      providerKey: string;
      adapterKey: string;
      configVersionId: string;
      configVersionNumber: bigint;
      configuration: Readonly<Record<string, unknown>>;
      configExpiresAt: Date | null;
      scheduleSeconds: number;
    }>;

const providerRootSelection =
  CentralPrisma.validator<CentralPrisma.providersSelect>()({
    id: true,
    provider_key: true,
    display_name: true,
    lifecycle: true,
    created_at: true,
    updated_at: true,
  });

const importAdmissionSelection =
  CentralPrisma.validator<CentralPrisma.providersSelect>()({
    id: true,
    provider_key: true,
    lifecycle: true,
    active_config_version_id: true,
    active_config_version: {
      select: {
        id: true,
        version_number: true,
        adapter_key: true,
        configuration: true,
        schedule_seconds: true,
        expires_at: true,
      },
    },
  });

type ProviderRootRow = CentralPrisma.providersGetPayload<{
  select: typeof providerRootSelection;
}>;

function providerRecord(row: ProviderRootRow): CentralAdminProviderRecord {
  return {
    id: row.id,
    provider: row.provider_key,
    displayName: row.display_name,
    state: row.lifecycle,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Current-admin projection over the central provider registry. The browser
 * receives its established DTO; database names, nodes, and credentials never
 * leave this server-owned repository.
 */
export class CentralAdminProviderRepository {
  constructor(private readonly central: CentralQueryClient) {}

  async listProviders(
    organizationId: string,
  ): Promise<readonly CentralAdminProviderRecord[]> {
    const rows = await this.central.providers.findMany({
      where: { organization_id: organizationId },
      orderBy: [{ provider_key: "asc" }, { id: "asc" }],
      select: providerRootSelection,
    });
    return rows.map(providerRecord);
  }

  async getProvider(
    organizationId: string,
    providerId: string,
  ): Promise<CentralAdminProviderRecord | null> {
    const row = await this.central.providers.findUnique({
      where: {
        id_organization_id: {
          id: providerId,
          organization_id: organizationId,
        },
      },
      select: providerRootSelection,
    });
    return row === null ? null : providerRecord(row);
  }

  async resolveImportAdmission(input: Readonly<{
    organizationId: string;
    providerId: string;
    expectedConfigVersionId: string;
    now: Date;
  }>): Promise<CentralProviderImportAdmission> {
    const row = await this.central.providers.findUnique({
      where: {
        id_organization_id: {
          id: input.providerId,
          organization_id: input.organizationId,
        },
      },
      select: importAdmissionSelection,
    });
    if (row === null) return { kind: "not_found" };

    const configuration = row.active_config_version;
    if (
      row.lifecycle !== "active"
      || row.active_config_version_id === null
      || configuration === null
      || configuration.id !== row.active_config_version_id
      || (configuration.expires_at !== null
        && configuration.expires_at.getTime() <= input.now.getTime())
    ) {
      return { kind: "source_unavailable" };
    }
    if (configuration.id !== input.expectedConfigVersionId) {
      return {
        kind: "revision_conflict",
        activeConfigVersionId: configuration.id,
      };
    }
    if (
      configuration.configuration === null
      || typeof configuration.configuration !== "object"
      || Array.isArray(configuration.configuration)
    ) {
      return { kind: "source_unavailable" };
    }
    return {
      kind: "ready",
      providerId: row.id,
      providerKey: row.provider_key,
      adapterKey: configuration.adapter_key,
      configVersionId: configuration.id,
      configVersionNumber: configuration.version_number,
      configuration: configuration.configuration as Readonly<Record<string, unknown>>,
      configExpiresAt: configuration.expires_at,
      scheduleSeconds: configuration.schedule_seconds,
    };
  }
}
