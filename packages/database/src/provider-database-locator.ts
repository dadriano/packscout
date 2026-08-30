import {
  Prisma as CentralPrisma,
  provider_lifecycle,
} from "../prisma/generated/central/index.js";
import type { CentralQueryClient } from "./central-database.ts";
import {
  assertDatabaseUuid,
  providerDatabaseTarget,
  type ProviderDatabaseTargetDescriptor,
} from "./database-topology.ts";

const providerRouteSelection = CentralPrisma.validator<CentralPrisma.providersSelect>()({
  id: true,
  organization_id: true,
  provider_key: true,
  lifecycle: true,
  active_config_version_id: true,
  active_config_version: {
    select: { id: true, expires_at: true },
  },
  topology_version: true,
  row_version: true,
  config_versions: {
    orderBy: [{ version_number: "desc" }, { id: "desc" }],
    take: 1,
    select: { id: true, expires_at: true },
  },
  database_nodes: {
    where: { enabled: true, node_role: "primary" },
    orderBy: { id: "asc" },
    take: 2,
    select: {
      id: true,
      host: true,
      port: true,
      database_name: true,
      ssl_mode: true,
      credential_version_id: true,
      row_version: true,
      credential: {
        select: {
          credential_kind: true,
          lifecycle: true,
          ciphertext: true,
          nonce: true,
          auth_tag: true,
          key_version: true,
        },
      },
    },
  },
});

type ProviderRouteRegistryRow = CentralPrisma.providersGetPayload<{
  select: typeof providerRouteSelection;
}>;

export type ProviderRouteFailureCode =
  | "PROVIDER_NOT_ROUTABLE"
  | "PROVIDER_CONFIG_VERSION_CONFLICT"
  | "PROVIDER_ROW_VERSION_CONFLICT"
  | "PROVIDER_CONFIG_EXPIRED"
  | "PROVIDER_DATABASE_NODE_UNAVAILABLE"
  | "PROVIDER_DATABASE_NAME_MISMATCH"
  | "PROVIDER_DATABASE_CREDENTIAL_UNAVAILABLE";

export interface ProviderDatabaseRoute {
  readonly target: ProviderDatabaseTargetDescriptor;
  readonly organizationId: string;
  readonly configVersionId: string;
  readonly providerRowVersion: bigint;
  readonly topologyVersion: bigint;
  readonly node: {
    readonly nodeId: string;
    readonly host: string;
    readonly port: number;
    readonly sslMode: string;
    readonly credentialVersionId: string;
    readonly encryptedCredential: {
      readonly ciphertext: Uint8Array;
      readonly nonce: Uint8Array;
      readonly authTag: Uint8Array;
      readonly keyVersion: number;
    };
    readonly rowVersion: bigint;
  };
}

export type ProviderDatabaseRouteResult =
  | { readonly state: "ready"; readonly route: ProviderDatabaseRoute }
  | { readonly state: "unavailable"; readonly failureCode: ProviderRouteFailureCode };

function evaluateNode(
  row: ProviderRouteRegistryRow,
  configVersionId: string,
): ProviderDatabaseRouteResult {
  if (row.database_nodes.length !== 1) {
    return {
      state: "unavailable",
      failureCode: "PROVIDER_DATABASE_NODE_UNAVAILABLE",
    };
  }
  const node = row.database_nodes[0]!;
  const target = providerDatabaseTarget({
    providerId: row.id,
    providerKey: row.provider_key,
  });
  if (node.database_name !== target.databaseName) {
    return {
      state: "unavailable",
      failureCode: "PROVIDER_DATABASE_NAME_MISMATCH",
    };
  }
  if (
    node.credential.credential_kind !== "database"
    || node.credential.lifecycle !== "active"
  ) {
    return {
      state: "unavailable",
      failureCode: "PROVIDER_DATABASE_CREDENTIAL_UNAVAILABLE",
    };
  }
  return {
    state: "ready",
    route: {
      target,
      organizationId: row.organization_id,
      configVersionId,
      providerRowVersion: row.row_version,
      topologyVersion: row.topology_version,
      node: {
        nodeId: node.id,
        host: node.host,
        port: node.port,
        sslMode: node.ssl_mode,
        credentialVersionId: node.credential_version_id,
        encryptedCredential: {
          ciphertext: node.credential.ciphertext,
          nonce: node.credential.nonce,
          authTag: node.credential.auth_tag,
          keyVersion: node.credential.key_version,
        },
        rowVersion: node.row_version,
      },
    },
  };
}

export function evaluateProviderDatabaseRoute(
  row: ProviderRouteRegistryRow | null,
  now: Date = new Date(),
): ProviderDatabaseRouteResult {
  if (
    !row
    || row.lifecycle !== provider_lifecycle.active
    || row.active_config_version_id === null
    || row.active_config_version === null
    || row.active_config_version.id !== row.active_config_version_id
  ) {
    return { state: "unavailable", failureCode: "PROVIDER_NOT_ROUTABLE" };
  }
  if (
    row.active_config_version.expires_at
    && row.active_config_version.expires_at.getTime() <= now.getTime()
  ) {
    return { state: "unavailable", failureCode: "PROVIDER_CONFIG_EXPIRED" };
  }
  return evaluateNode(row, row.active_config_version_id);
}

/**
 * Admin reads and runtime controls remain available for a centrally disabled
 * provider so operators can inspect history and recover it. Draft and archived
 * providers never expose a reusable operational route. Source-config expiry is
 * revalidated by the provider database for work creation, not used to hide the
 * database from administrative stop or diagnostic reads.
 */
export function evaluateProviderAdminDatabaseRoute(
  row: ProviderRouteRegistryRow | null,
): ProviderDatabaseRouteResult {
  if (
    !row
    || (row.lifecycle !== provider_lifecycle.active
      && row.lifecycle !== provider_lifecycle.disabled)
    || row.active_config_version_id === null
    || row.active_config_version === null
    || row.active_config_version.id !== row.active_config_version_id
  ) {
    return { state: "unavailable", failureCode: "PROVIDER_NOT_ROUTABLE" };
  }
  return evaluateNode(row, row.active_config_version_id);
}

export function evaluateProviderActivationTestRoute(
  row: ProviderRouteRegistryRow | null,
  input: {
    readonly expectedConfigVersionId: string;
    readonly expectedRowVersion: bigint;
    readonly now?: Date;
  },
): ProviderDatabaseRouteResult {
  if (!row || row.lifecycle === provider_lifecycle.archived) {
    return { state: "unavailable", failureCode: "PROVIDER_NOT_ROUTABLE" };
  }
  const latest = row.config_versions[0];
  if (!latest || latest.id !== input.expectedConfigVersionId) {
    return {
      state: "unavailable",
      failureCode: "PROVIDER_CONFIG_VERSION_CONFLICT",
    };
  }
  if (row.row_version !== input.expectedRowVersion) {
    return {
      state: "unavailable",
      failureCode: "PROVIDER_ROW_VERSION_CONFLICT",
    };
  }
  if (
    latest.expires_at
    && latest.expires_at.getTime() <= (input.now ?? new Date()).getTime()
  ) {
    return { state: "unavailable", failureCode: "PROVIDER_CONFIG_EXPIRED" };
  }
  return evaluateNode(row, latest.id);
}

/**
 * Resolves exclusively from central provider and authenticated organization
 * UUIDs. The caller cannot supply provider key, host, database name, or URL.
 */
export async function locateProviderDatabase(
  central: CentralQueryClient,
  input: { readonly organizationId: string; readonly providerId: string },
): Promise<ProviderDatabaseRouteResult> {
  assertDatabaseUuid(input.organizationId, "Organization ID");
  assertDatabaseUuid(input.providerId, "Provider ID");
  const provider = await central.providers.findUnique({
    where: {
      id_organization_id: {
        id: input.providerId,
        organization_id: input.organizationId,
      },
    },
    select: providerRouteSelection,
  });
  return evaluateProviderDatabaseRoute(provider);
}

/** Resolves an organization-owned route for bounded admin reads and controls. */
export async function locateProviderAdminDatabase(
  central: CentralQueryClient,
  input: { readonly organizationId: string; readonly providerId: string },
): Promise<ProviderDatabaseRouteResult> {
  assertDatabaseUuid(input.organizationId, "Organization ID");
  assertDatabaseUuid(input.providerId, "Provider ID");
  const provider = await central.providers.findUnique({
    where: {
      id_organization_id: {
        id: input.providerId,
        organization_id: input.organizationId,
      },
    },
    select: providerRouteSelection,
  });
  return evaluateProviderAdminDatabaseRoute(provider);
}

/** Resolves an exact draft or disabled activation target without making it active. */
export async function locateProviderActivationTestDatabase(
  central: CentralQueryClient,
  input: {
    readonly organizationId: string;
    readonly providerId: string;
    readonly expectedConfigVersionId: string;
    readonly expectedRowVersion: bigint;
    readonly now?: Date;
  },
): Promise<ProviderDatabaseRouteResult> {
  assertDatabaseUuid(input.organizationId, "Organization ID");
  assertDatabaseUuid(input.providerId, "Provider ID");
  assertDatabaseUuid(input.expectedConfigVersionId, "Configuration version ID");
  const provider = await central.providers.findUnique({
    where: {
      id_organization_id: {
        id: input.providerId,
        organization_id: input.organizationId,
      },
    },
    select: providerRouteSelection,
  });
  return evaluateProviderActivationTestRoute(provider, input);
}

export function providerDatabaseRouteFingerprint(route: ProviderDatabaseRoute): string {
  return [
    route.target.providerId,
    route.configVersionId,
    route.providerRowVersion.toString(),
    route.topologyVersion.toString(),
    route.node.nodeId,
    route.node.rowVersion.toString(),
    route.node.credentialVersionId,
  ].join(":");
}
