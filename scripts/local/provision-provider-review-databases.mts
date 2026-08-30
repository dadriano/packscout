#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLUTCHPACKS_REVIEW_DATABASES,
  type ClutchpacksReviewDatabaseTarget,
} from "./clutchpacks-review-database-plan.mjs";
import {
  assertAdditiveProviderClusterLayout,
  assertFixedPg16Binaries,
  clusterDatabaseUrl,
  clusterMigrationUrl,
  initializeFixedCluster,
  inspectFixedCluster,
  markFixedClusterProvisioned,
  readConnectedClusterProof,
  readProvisioningConnectedClusterProof,
  startFixedCluster,
  stopFixedCluster,
  type ClusterFilesystemProof,
  type ConnectedClusterProof,
} from "./clutchpacks-review-cluster-runtime.mts";
import {
  createReviewClusterDatabase,
  expectReviewConnectionDenied,
  expectReviewProviderInitializerDenied,
  grantExplicitReviewRuntimeAccess,
  initializeReviewProviderIdentity,
  migrateReviewDatabase,
} from "./provision-clutchpacks-review-databases.mts";
import {
  ADDITIONAL_PROVIDER_REVIEW_DATABASES,
  ALL_PROVIDER_REVIEW_DATABASES,
  ProviderReviewProvisionError,
  assertAdditionalProviderRuntimeSelection,
  assertDistinctProviderReviewClusterProofs,
  assertNoProviderReviewProvisionArguments,
  buildSanitizedProviderReviewIsolationProof,
  buildAdditionalProviderProvisionPlan,
  providerReviewDataDirectoryHash,
  readProviderReviewProvisionEnvironment,
  safeProviderReviewProvisionFailure,
  type AdditionalProviderKey,
  type ProviderReviewProvisionEnvironment,
  type ProviderReviewReadEnvironment,
  type ReviewProviderDescriptor,
} from "./provider-review-database-plan.mts";
import {
  createProviderReviewRegistrationIds,
  readProviderReviewCentralBaseline,
  registerProviderReviewMetadataBatch,
  type ProviderReviewRegistrationIds,
} from "./provider-review-central-registration.mts";
import {
  verifyFreshProviderReviewDatabase,
} from "./provider-review-database-verification.mts";

function refuse(code: string): never {
  throw new ProviderReviewProvisionError(code);
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function sanitizeFilesystemProof(proof: Readonly<ClusterFilesystemProof>) {
  return Object.freeze({
    clusterKey: proof.clusterKey,
    databaseName: proof.databaseName,
    port: proof.port,
    directoryState: proof.directoryState,
    running: proof.running,
    systemIdentifier: proof.systemIdentifier,
    dataDirectoryHash: providerReviewDataDirectoryHash(proof.dataDirectory),
  });
}

function sanitizeConnectedClusterProof(proof: Readonly<ConnectedClusterProof>) {
  return Object.freeze({
    clusterKey: proof.clusterKey,
    databaseName: proof.databaseName,
    databaseRole: proof.databaseRole,
    port: proof.port,
    schemaVersion: proof.schemaVersion,
    systemIdentifier: proof.systemIdentifier,
    dataDirectoryHash: providerReviewDataDirectoryHash(proof.dataDirectory),
  });
}

function providerCredential(
  environment: ProviderReviewProvisionEnvironment | ProviderReviewReadEnvironment,
  provider: Readonly<ReviewProviderDescriptor>,
) {
  return environment.credentials[provider.providerKey];
}

function requiredPassword(value: string | null): string {
  if (value === null) refuse("PROVISION_CREDENTIAL_INVALID");
  return value;
}

async function inspectAction(
  environment: ProviderReviewReadEnvironment,
): Promise<void> {
  const clusters = [];
  for (const provider of environment.selected) {
    const filesystem = await inspectFixedCluster(provider);
    const password = providerCredential(environment, provider).appPassword;
    const connected = filesystem.running &&
        filesystem.directoryState === "provisioned" && password !== null
      ? await readConnectedClusterProof({ cluster: provider, appPassword: password })
      : null;
    clusters.push({
      filesystem: sanitizeFilesystemProof(filesystem),
      connected: connected === null
        ? null
        : sanitizeConnectedClusterProof(connected),
    });
  }
  emit({
    ok: true,
    operation: "inspect_additional_provider_review_clusters",
    target: environment.target,
    clusters,
    credentialsPrinted: false,
  });
}

async function startAction(
  environment: ProviderReviewReadEnvironment,
): Promise<void> {
  const provider = environment.selected[0];
  if (provider === undefined) refuse("CLUSTER_ACTION_INVALID");
  const filesystem = await startFixedCluster(provider);
  const connected = filesystem.directoryState === "provisioned"
    ? await readConnectedClusterProof({
        cluster: provider,
        appPassword: requiredPassword(
          providerCredential(environment, provider).appPassword,
        ),
      })
    : null;
  emit({
    ok: true,
    operation: "start_additional_provider_review_cluster",
    filesystem: sanitizeFilesystemProof(filesystem),
    connected: connected === null ? null : sanitizeConnectedClusterProof(connected),
    credentialsPrinted: false,
  });
}

async function requireRunningBaseline(
  environment: ProviderReviewProvisionEnvironment,
): Promise<readonly Readonly<ConnectedClusterProof>[]> {
  const inputs = [
    {
      cluster: CLUTCHPACKS_REVIEW_DATABASES.central,
      appPassword: environment.centralAppPassword,
    },
    {
      cluster: CLUTCHPACKS_REVIEW_DATABASES.provider,
      appPassword: environment.clutchpacksAppPassword,
    },
  ] as const;
  const proofs = [];
  for (const input of inputs) {
    const filesystem = await inspectFixedCluster(input.cluster);
    if (!filesystem.running || filesystem.marker?.state !== "provisioned") {
      refuse("BASE_REVIEW_CLUSTER_NOT_READY");
    }
    proofs.push(await readConnectedClusterProof(input));
  }
  return Object.freeze(proofs);
}

function providerIdsByKey(input: {
  readonly centralSystemIdentifier: string;
  readonly providerSystemIdentifiers: Readonly<Record<AdditionalProviderKey, string>>;
}): Readonly<Record<AdditionalProviderKey, Readonly<ProviderReviewRegistrationIds>>> {
  return Object.freeze(Object.fromEntries(
    ADDITIONAL_PROVIDER_REVIEW_DATABASES.map((provider) => [
      provider.providerKey,
      createProviderReviewRegistrationIds({
        centralSystemIdentifier: input.centralSystemIdentifier,
        providerSystemIdentifier:
          input.providerSystemIdentifiers[provider.providerKey],
        providerKey: provider.providerKey,
      }),
    ]),
  ) as Record<AdditionalProviderKey, Readonly<ProviderReviewRegistrationIds>>);
}

async function proveRoleIsolation(input: {
  readonly environment: ProviderReviewProvisionEnvironment;
  readonly providerUrls: Readonly<Record<AdditionalProviderKey, string>>;
}): Promise<void> {
  const applicationIdentities = [
    {
      cluster: CLUTCHPACKS_REVIEW_DATABASES.central,
      password: input.environment.centralAppPassword,
    },
    {
      cluster: CLUTCHPACKS_REVIEW_DATABASES.provider,
      password: input.environment.clutchpacksAppPassword,
    },
    ...ADDITIONAL_PROVIDER_REVIEW_DATABASES.map((provider) => ({
      cluster: provider,
      password: requiredPassword(
        providerCredential(input.environment, provider).appPassword,
      ),
    })),
  ];
  const denials = applicationIdentities.flatMap((source) =>
    ALL_PROVIDER_REVIEW_DATABASES
      .filter((target) => target.clusterKey !== source.cluster.clusterKey)
      .map((target) => expectReviewConnectionDenied(clusterDatabaseUrl({
        cluster: target,
        username: source.cluster.appRoleName,
        password: source.password,
      })))
  );
  await Promise.all(denials);
  await Promise.all(ADDITIONAL_PROVIDER_REVIEW_DATABASES.map((provider) =>
    expectReviewProviderInitializerDenied({
      providerUrl: input.providerUrls[provider.providerKey],
      providerKey: provider.providerKey,
    })
  ));
}

async function provisionAction(
  environment: ProviderReviewProvisionEnvironment,
): Promise<void> {
  await assertAdditiveProviderClusterLayout({
    existing: [
      CLUTCHPACKS_REVIEW_DATABASES.central,
      CLUTCHPACKS_REVIEW_DATABASES.provider,
    ],
    additions: ADDITIONAL_PROVIDER_REVIEW_DATABASES,
  });
  const baselineProofs = await requireRunningBaseline(environment);
  const started: ClutchpacksReviewDatabaseTarget[] = [];
  try {
    const markers = {} as Record<AdditionalProviderKey, {
      readonly systemIdentifier: string;
    }>;
    for (const provider of ADDITIONAL_PROVIDER_REVIEW_DATABASES) {
      const credentials = providerCredential(environment, provider);
      markers[provider.providerKey] = await initializeFixedCluster(
        provider,
        requiredPassword(credentials.clusterAdminPassword),
      );
    }
    assertDistinctProviderReviewClusterProofs([
      ...baselineProofs,
      ...ADDITIONAL_PROVIDER_REVIEW_DATABASES.map((provider) => ({
        ...provider,
        systemIdentifier: markers[provider.providerKey].systemIdentifier,
      })),
    ]);

    const providerUrls = {} as Record<AdditionalProviderKey, string>;
    const providerMigrationUrls = {} as Record<AdditionalProviderKey, string>;
    for (const provider of ADDITIONAL_PROVIDER_REVIEW_DATABASES) {
      const credentials = providerCredential(environment, provider);
      const before = await inspectFixedCluster(provider);
      await startFixedCluster(provider);
      if (!before.running) started.push(provider);
      await createReviewClusterDatabase({
        cluster: provider,
        clusterAdminPassword: requiredPassword(credentials.clusterAdminPassword),
        appPassword: requiredPassword(credentials.appPassword),
      });
      const migrationUrl = clusterMigrationUrl({
        cluster: provider,
        clusterAdminPassword: requiredPassword(credentials.clusterAdminPassword),
      });
      migrateReviewDatabase({ databaseUrl: migrationUrl, role: "provider" });
      providerMigrationUrls[provider.providerKey] = migrationUrl;
      providerUrls[provider.providerKey] = clusterDatabaseUrl({
        cluster: provider,
        username: provider.appRoleName,
        password: requiredPassword(credentials.appPassword),
      });
    }

    const ids = providerIdsByKey({
      centralSystemIdentifier: baselineProofs[0]!.systemIdentifier,
      providerSystemIdentifiers: Object.fromEntries(
        ADDITIONAL_PROVIDER_REVIEW_DATABASES.map((provider) => [
          provider.providerKey,
          markers[provider.providerKey].systemIdentifier,
        ]),
      ) as Record<AdditionalProviderKey, string>,
    });
    buildAdditionalProviderProvisionPlan(ids);
    for (const provider of ADDITIONAL_PROVIDER_REVIEW_DATABASES) {
      const credentials = providerCredential(environment, provider);
      await initializeReviewProviderIdentity({
        databaseUrl: providerMigrationUrls[provider.providerKey],
        providerId: ids[provider.providerKey].providerId,
        providerKey: provider.providerKey,
      });
      await grantExplicitReviewRuntimeAccess({
        cluster: provider,
        clusterAdminPassword: requiredPassword(credentials.clusterAdminPassword),
        provider: true,
      });
    }
    await proveRoleIsolation({ environment, providerUrls });

    const additionalProofs = await Promise.all(
      ADDITIONAL_PROVIDER_REVIEW_DATABASES.map((provider) =>
        readProvisioningConnectedClusterProof({
          cluster: provider,
          appPassword: requiredPassword(
            providerCredential(environment, provider).appPassword,
          ),
        })
      ),
    );
    assertDistinctProviderReviewClusterProofs([
      ...baselineProofs,
      ...additionalProofs,
    ]);
    for (const provider of ADDITIONAL_PROVIDER_REVIEW_DATABASES) {
      await verifyFreshProviderReviewDatabase({
        databaseUrl: providerUrls[provider.providerKey],
        descriptor: provider,
        providerId: ids[provider.providerKey].providerId,
      });
    }

    const centralUrl = clusterDatabaseUrl({
      cluster: CLUTCHPACKS_REVIEW_DATABASES.central,
      username: CLUTCHPACKS_REVIEW_DATABASES.central.appRoleName,
      password: environment.centralAppPassword,
    });
    const baseline = await readProviderReviewCentralBaseline({
      centralUrl,
      organizationSlug: environment.organizationSlug,
      adminEmail: environment.adminEmail,
    });
    await registerProviderReviewMetadataBatch({
      centralUrl,
      registrations: ADDITIONAL_PROVIDER_REVIEW_DATABASES.map(
        (provider, index) => ({
          descriptor: provider,
          ids: ids[provider.providerKey],
          databasePassword: requiredPassword(
            providerCredential(environment, provider).appPassword,
          ),
          databaseProof: additionalProofs[index]!,
        }),
      ),
      baseline,
      credentialKey: environment.credentialKey,
    });

    for (const provider of ADDITIONAL_PROVIDER_REVIEW_DATABASES) {
      await markFixedClusterProvisioned(provider);
    }
    const providerIsolation = buildSanitizedProviderReviewIsolationProof([
      {
        ...baselineProofs[1]!,
        providerKey: "clutchpacks",
        providerId: baseline.clutchpacksProviderId,
        databaseNodeId: baseline.clutchpacksDatabaseNodeId,
        databaseCredentialVersionId:
          baseline.clutchpacksDatabaseCredentialVersionId,
      },
      ...ADDITIONAL_PROVIDER_REVIEW_DATABASES.map((provider, index) => ({
        ...additionalProofs[index]!,
        providerKey: provider.providerKey,
        providerId: ids[provider.providerKey].providerId,
        databaseNodeId: ids[provider.providerKey].databaseNodeId,
        databaseCredentialVersionId:
          ids[provider.providerKey].databaseCredentialVersionId,
      })),
    ]);
    const additionalProviderRuntime = await Promise.all(
      ADDITIONAL_PROVIDER_REVIEW_DATABASES.map(async (provider) => ({
        providerKey: provider.providerKey,
        running: (await inspectFixedCluster(provider)).running,
      })),
    );
    assertAdditionalProviderRuntimeSelection(additionalProviderRuntime);
    emit({
      ok: true,
      operation: "provision_additional_provider_review_clusters",
      clusters: additionalProofs.map(sanitizeConnectedClusterProof),
      providers: ADDITIONAL_PROVIDER_REVIEW_DATABASES.map((provider) => ({
        providerKey: provider.providerKey,
        providerId: ids[provider.providerKey].providerId,
        adapterKey: provider.adapterKey,
        executionCapability: provider.executionCapability,
      })),
      providerIsolation,
      additionalProviderRuntime,
      existingClustersMutated: false,
      credentialsPrinted: false,
    });
  } catch (error) {
    for (const cluster of started.toReversed()) {
      await stopFixedCluster(cluster).catch(() => undefined);
    }
    throw error;
  }
}

async function main(): Promise<void> {
  assertNoProviderReviewProvisionArguments(process.argv.slice(2));
  const environment = readProviderReviewProvisionEnvironment(process.env);
  await assertFixedPg16Binaries();
  if (environment.action === "inspect") {
    await inspectAction(environment);
    return;
  }
  if (environment.action === "start") {
    await startAction(environment);
    return;
  }
  if (environment.action === "stop") {
    const provider = environment.selected[0];
    if (provider === undefined) refuse("CLUSTER_ACTION_INVALID");
    emit({
      ok: true,
      operation: "stop_additional_provider_review_cluster",
      filesystem: sanitizeFilesystemProof(await stopFixedCluster(provider)),
    });
    return;
  }
  if (environment.action !== "provision") refuse("CLUSTER_ACTION_INVALID");
  await provisionAction(environment);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify(safeProviderReviewProvisionFailure(error))}\n`);
    process.exitCode = 1;
  });
}
