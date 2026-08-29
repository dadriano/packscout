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
  topology_version: true,
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
  | "PROVIDER_DATABASE_NODE_UNAVAILABLE"
  | "PROVIDER_DATABASE_NAME_MISMATCH"
  | "PROVIDER_DATABASE_CREDENTIAL_UNAVAILABLE";

export interface ProviderDatabaseRoute {
  readonly target: ProviderDatabaseTargetDescriptor;
  readonly topologyVersion: bigint;
  readonly node: {
    readonly nodeId: string;
    readonly host: string;
    readonly port: number;
    readonly sslMode: string;
    readonly credentialVersionId: string;
    readonly rowVersion: bigint;
  };
}

export type ProviderDatabaseRouteResult =
  | { readonly state: "ready"; readonly route: ProviderDatabaseRoute }
  | { readonly state: "unavailable"; readonly failureCode: ProviderRouteFailureCode };

export function evaluateProviderDatabaseRoute(
  row: ProviderRouteRegistryRow | null,
): ProviderDatabaseRouteResult {
  if (!row || row.lifecycle !== provider_lifecycle.active) {
    return { state: "unavailable", failureCode: "PROVIDER_NOT_ROUTABLE" };
  }
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
      topologyVersion: row.topology_version,
      node: {
        nodeId: node.id,
        host: node.host,
        port: node.port,
        sslMode: node.ssl_mode,
        credentialVersionId: node.credential_version_id,
        rowVersion: node.row_version,
      },
    },
  };
}

/**
 * Resolves exclusively from a central provider UUID plus authenticated
 * organization UUID. No provider key, database name, host, or credential is
 * accepted from the caller as routing authority.
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
