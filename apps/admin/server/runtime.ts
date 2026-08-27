import { RECOMPUTATION_BACKLOG_DEPTH_DEFAULT } from "@packscout/contracts";
import {
  createPrismaClientLifecycle,
  DatabaseLoginAttemptLimiter,
  PrismaAuthAuditSink,
  PrismaAuthRepository,
  PrismaCanonicalInspectionRepository,
  PrismaProviderConfigurationRepository,
  PrismaProviderHealthRepository,
  PrismaProviderPromotionFactsRepository,
} from "@packscout/database";
import {
  CanonicalInspectionService,
  MachineryAlertService,
  resolveEmailLinkTokenSecret,
} from "@packscout/services";
import { createAdminAccessDecisionNoticeRuntime } from "./access-decision-notice-runtime.ts";
import { createAdminApp } from "./app.ts";
import { createAdminAuthRuntime } from "./auth/runtime.ts";
import { createAdminBackgroundWorkRuntime } from "./background-work-runtime.ts";
import { createBetaAllowlistAuditSink } from "./beta-allowlist-audit.ts";
import { createBetaAllowlistDirectoryClient } from "./beta-allowlist-directory.ts";
import { createAdminImportOperationsRuntime } from "./import-operations-runtime.ts";
import {
  createAdminMachineryAlertFactsSource,
  createAdminMachineryAlertObserver,
} from "./machinery-alert-runtime.ts";
import { createAdminMessageDeliveryRuntime } from "./message-delivery-runtime.ts";
import { createAdminOperationalRuntime } from "./operational-runtime.ts";
import { createAdminOperatorAccountCreatedNoticeRuntime } from "./operator-account-created-notice-runtime.ts";
import { createAdminOperatorInvitationRuntime } from "./operator-invitation-runtime.ts";
import { createParityRuntime } from "./parity-runtime.ts";
import { createAdminPasswordResetRuntime } from "./password-reset-runtime.ts";
import { createProductUserAuditSink } from "./product-user-audit.ts";
import { createProductUserDirectoryReader } from "./product-user-directory.ts";
import { createProviderAdminRuntime } from "./provider-runtime.ts";
import { createAdminProviderSourceRuntime } from "./provider-source-runtime.ts";
import { createPublishedCatalogReader } from "./published-catalog-reader.ts";
import {
  adminDevelopmentAllowedOrigins,
  readAllowedOrigins,
  readBase64Key,
  readCatalogDeploymentKey,
  readPort,
  readPositiveCount,
  readPositiveDuration,
  readProductUserDirectoryConfig,
  readRequiredSecret,
  readServiceHost,
  readSourceAdministrationSettings,
  readTrustedProxies,
} from "./runtime-config.ts";
import { createAdminWorkerFleetRuntime } from "./worker-fleet-runtime.ts";

export interface AdminRuntimeConfiguration {
  readonly development: boolean;
  readonly host: string;
  readonly port: number;
  readonly machineryAlertIntervalMs: number;
  readonly productUserDirectoryConfigured: boolean;
  readonly sourceAdministrationConfigured: boolean;
  readonly emailLinkTokenConfigured: boolean;
}

export interface AdminRuntime {
  readonly app: ReturnType<typeof createAdminApp>;
  readonly configuration: AdminRuntimeConfiguration;
  runMachineryAlertCycle(): ReturnType<MachineryAlertService["runCycle"]>;
  close(): Promise<void>;
}

export interface CreateAdminRuntimeInput {
  readonly environment?: NodeJS.ProcessEnv;
  /** Adapter-validated listening port for self-hosted process models. */
  readonly port?: number;
  /**
   * Vercel terminates the public connection one trusted hop before Express and
   * overwrites the forwarded-for header. The deployment adapter opts into that
   * single hop; self-hosted processes continue to require explicit CIDRs.
   */
  readonly trustedProxyHops?: number;
}

/**
 * Composes the admin's database-backed behavior without choosing a process
 * model. The self-host adapter owns listeners and timers; the Vercel adapter
 * owns request dispatch and its scheduler endpoint.
 */
export async function createAdminRuntime(
  input: CreateAdminRuntimeInput = {},
): Promise<AdminRuntime> {
  const environment = input.environment ?? process.env;
  const development = environment.NODE_ENV !== "production";
  const port = readPort(
    input.port === undefined
      ? environment.PACKSCOUT_ADMIN_PORT
      : String(input.port),
    5101,
    "PACKSCOUT_ADMIN_PORT",
  );
  const host = readServiceHost(
    environment.PACKSCOUT_ADMIN_HOST,
    development ? "127.0.0.1" : "0.0.0.0",
    "PACKSCOUT_ADMIN_HOST",
    development,
  );
  const sessionIdleMs = readPositiveDuration(
    environment.PACKSCOUT_SESSION_IDLE_MS,
    60 * 60 * 1_000,
    "PACKSCOUT_SESSION_IDLE_MS",
  );
  const sessionAbsoluteMs = readPositiveDuration(
    environment.PACKSCOUT_SESSION_ABSOLUTE_MS,
    12 * 60 * 60 * 1_000,
    "PACKSCOUT_SESSION_ABSOLUTE_MS",
  );
  if (sessionAbsoluteMs < sessionIdleMs) {
    throw new Error(
      "PACKSCOUT_SESSION_ABSOLUTE_MS must be greater than or equal to PACKSCOUT_SESSION_IDLE_MS.",
    );
  }

  const databaseUrl = readRequiredSecret(
    environment.PACKSCOUT_DATABASE_URL,
    "PACKSCOUT_DATABASE_URL",
  );
  const sessionSecret = readRequiredSecret(
    environment.PACKSCOUT_SESSION_HASHING_SECRET,
    "PACKSCOUT_SESSION_HASHING_SECRET",
    32,
  );
  const providerCredentialKey = readBase64Key(
    environment.PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64,
    "PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64",
  );
  const providerActorKey = readBase64Key(
    environment.PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64,
    "PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64",
  );
  const sourceAdministration = readSourceAdministrationSettings({
    key: environment.PACKSCOUT_SOURCE_CONNECTION_KEY_BASE64,
    keyVersion: environment.PACKSCOUT_SOURCE_CONNECTION_KEY_VERSION,
  });
  const allowedOrigins = readAllowedOrigins(
    environment.PACKSCOUT_ADMIN_ALLOWED_ORIGINS,
    development ? adminDevelopmentAllowedOrigins(host, port) : [],
    "PACKSCOUT_ADMIN_ALLOWED_ORIGINS",
  );
  const configuredTrustedProxies = readTrustedProxies(
    environment.PACKSCOUT_ADMIN_TRUSTED_PROXIES,
    "PACKSCOUT_ADMIN_TRUSTED_PROXIES",
  );
  if (
    input.trustedProxyHops !== undefined &&
    (!Number.isInteger(input.trustedProxyHops) || input.trustedProxyHops < 1)
  ) {
    throw new Error("Trusted proxy hops must be a positive integer.");
  }
  if (
    input.trustedProxyHops !== undefined &&
    configuredTrustedProxies.length > 0
  ) {
    throw new Error(
      "PACKSCOUT_ADMIN_TRUSTED_PROXIES cannot be combined with adapter-owned proxy hops.",
    );
  }

  const machineryAlertIntervalMs = readPositiveDuration(
    environment.PACKSCOUT_ADMIN_MACHINERY_ALERT_INTERVAL_MS,
    60 * 1_000,
    "PACKSCOUT_ADMIN_MACHINERY_ALERT_INTERVAL_MS",
  );
  const recomputationBacklogLimit = readPositiveCount(
    environment.PACKSCOUT_ADMIN_RECOMPUTATION_BACKLOG_LIMIT,
    RECOMPUTATION_BACKLOG_DEPTH_DEFAULT,
    "PACKSCOUT_ADMIN_RECOMPUTATION_BACKLOG_LIMIT",
  );
  const catalogDeploymentKey = readCatalogDeploymentKey(environment);
  const productUserDirectoryConfig = readProductUserDirectoryConfig({
    baseUrl: environment.PACKSCOUT_ADMIN_DIRECTORY_URL,
    token: environment.PACKSCOUT_ADMIN_DIRECTORY_TOKEN,
  });
  const emailLinkTokenSecret = resolveEmailLinkTokenSecret(environment);
  const databaseLifecycle = createPrismaClientLifecycle({ databaseUrl });

  try {
    await databaseLifecycle.start();
    const database = databaseLifecycle.client;
    const canonicalInspection = new CanonicalInspectionService(
      new PrismaCanonicalInspectionRepository(database),
    );
    const providerRepository = new PrismaProviderConfigurationRepository(database);
    const operational = createAdminOperationalRuntime({
      database,
      actorPseudonymKey: providerActorKey,
      alertEmail: { env: environment },
    });
    const auth = await createAdminAuthRuntime({
      repository: new PrismaAuthRepository(database),
      loginLimiter: new DatabaseLoginAttemptLimiter(database, {
        windowMs: 15 * 60 * 1_000,
        blockMs: 15 * 60 * 1_000,
        maximumFailures: 8,
      }),
      audit: new PrismaAuthAuditSink(database),
      sessionSecret,
      sessionIdleMs,
      sessionAbsoluteMs,
      production: !development,
      allowedOrigins,
    });
    const providerSourceRuntime = sourceAdministration
      ? createAdminProviderSourceRuntime({
          database,
          connectionConfigurationKey:
            sourceAdministration.connectionConfigurationKey,
          connectionConfigurationKeyVersion:
            sourceAdministration.connectionConfigurationKeyVersion,
          actorPseudonymKey: providerActorKey,
          environment: development ? "local" : "production",
        })
      : undefined;
    const directory = createProductUserDirectoryReader({
      config: productUserDirectoryConfig,
    });
    const app = createAdminApp({
      trustedProxies: configuredTrustedProxies,
      trustedProxyHops: input.trustedProxyHops,
      auth,
      providers: createProviderAdminRuntime({
        repository: providerRepository,
        healthRepository: new PrismaProviderHealthRepository(database),
        credentialKey: providerCredentialKey,
        actorPseudonymKey: providerActorKey,
        environment: development ? "local" : "production",
        operational,
      }),
      importOperations: createAdminImportOperationsRuntime({
        database,
        actorPseudonymKey: providerActorKey,
      }),
      backgroundWork: createAdminBackgroundWorkRuntime({
        database,
        actorPseudonymKey: providerActorKey,
        backlogDepthLimit: recomputationBacklogLimit,
      }),
      workerFleet: createAdminWorkerFleetRuntime({ database }),
      canonical: canonicalInspection,
      parity:
        catalogDeploymentKey === null
          ? undefined
          : createParityRuntime({
              canonical: canonicalInspection,
              promotion: new PrismaProviderPromotionFactsRepository(database),
              published: createPublishedCatalogReader({
                config: productUserDirectoryConfig,
              }),
              deploymentKey: catalogDeploymentKey,
            }),
      productUsers: {
        directory,
        audit: createProductUserAuditSink({
          database,
          actorPseudonymKey: providerActorKey,
        }),
        decisionNotice: createAdminAccessDecisionNoticeRuntime({
          database,
          directory,
        }),
      },
      betaAllowlist: {
        directory: createBetaAllowlistDirectoryClient({
          config: productUserDirectoryConfig,
        }),
        audit: createBetaAllowlistAuditSink({
          database,
          actorPseudonymKey: providerActorKey,
        }),
      },
      operationalAlerts: { alerts: operational.alerts },
      operationalHealth: { health: operational.health },
      providerSources: providerSourceRuntime,
      providerSourceOperations: providerSourceRuntime,
      sourceAdministrationUnconfigured: providerSourceRuntime === undefined,
      messages: createAdminMessageDeliveryRuntime({
        database,
        actorPseudonymKey: providerActorKey,
      }),
      passwordReset:
        emailLinkTokenSecret === null
          ? undefined
          : createAdminPasswordResetRuntime({
              database,
              authService: auth.service,
              secret: emailLinkTokenSecret,
            }),
      operatorInvitations:
        emailLinkTokenSecret === null
          ? undefined
          : createAdminOperatorInvitationRuntime({
              database,
              authService: auth.service,
              secret: emailLinkTokenSecret,
            }),
      operatorAccountCreatedNotifier:
        createAdminOperatorAccountCreatedNoticeRuntime({ database }),
    });
    const machineryAlerts = new MachineryAlertService(
      createAdminMachineryAlertFactsSource({
        database,
        backlogDepthLimit: recomputationBacklogLimit,
      }),
      operational.events,
      createAdminMachineryAlertObserver(),
    );
    let closePromise: Promise<void> | undefined;

    return {
      app,
      configuration: {
        development,
        host,
        port,
        machineryAlertIntervalMs,
        productUserDirectoryConfigured: productUserDirectoryConfig !== null,
        sourceAdministrationConfigured: sourceAdministration !== null,
        emailLinkTokenConfigured: emailLinkTokenSecret !== null,
      },
      runMachineryAlertCycle: () => machineryAlerts.runCycle(),
      close() {
        closePromise ??= databaseLifecycle.close();
        return closePromise;
      },
    };
  } catch (error) {
    await databaseLifecycle.close().catch(() => undefined);
    throw error;
  }
}
