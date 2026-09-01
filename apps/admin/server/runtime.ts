import { RECOMPUTATION_BACKLOG_DEPTH_DEFAULT } from "@packscout/contracts";
import {
  CentralAuthAuditSink,
  CentralAuthRepository,
  CentralLoginAttemptLimiter,
  CentralWorkerPresenceRepository,
  createCentralDatabaseLifecycle,
  type CentralPrismaClient,
  type PrismaWorkerFleetReadRepository,
} from "@packscout/database";
import {
  MachineryAlertService,
  resolveEmailLinkTokenSecret,
  type MachineryAlertFactsSource,
  type OperationalHealthRepository,
} from "@packscout/services";
import { createAdminAccessDecisionNoticeRuntime } from "./access-decision-notice-runtime.ts";
import {
  createAdminApp,
  type AdminAppDependencies,
} from "./app.ts";
import { createAdminAuthRuntime } from "./auth/runtime.ts";
import { createBetaAllowlistAuditSink } from "./beta-allowlist-audit.ts";
import { createBetaAllowlistDirectoryClient } from "./beta-allowlist-directory.ts";
import { createAdminCentralOperationalRuntime } from "./central-operational-runtime.ts";
import { createAdminMachineryAlertObserver } from "./machinery-alert-runtime.ts";
import { createAdminMessageDeliveryRuntime } from "./message-delivery-runtime.ts";
import { createAdminOperatorAccountCreatedNoticeRuntime } from "./operator-account-created-notice-runtime.ts";
import { createAdminOperatorInvitationRuntime } from "./operator-invitation-runtime.ts";
import { createAdminPasswordResetRuntime } from "./password-reset-runtime.ts";
import { createProductUserAuditSink } from "./product-user-audit.ts";
import { createProductUserDirectoryReader } from "./product-user-directory.ts";
import { withProductUserProfiles } from "./product-user-profiles.ts";
import { createPrivyProductUserProfileReader } from "./privy-product-user-profile.ts";
import { createCentralProviderAdminRuntime } from "./provider-runtime.ts";
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
  type SourceAdministrationSettings,
} from "./runtime-config.ts";
import { createDistributedAdminWorkerFleetRuntime } from "./worker-fleet-runtime.ts";

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

type ProviderAppDependencies = Pick<
  AdminAppDependencies,
  | "importOperations"
  | "backgroundWork"
  | "canonical"
  | "parity"
  | "providerSources"
  | "providerRequestSettings"
  | "providerSourceOperations"
>;

/**
 * Provider-owned dependencies required before the distributed admin can boot.
 * The factory may route across providers, but it never hands a database client
 * or connection string to a browser-selected request.
 */
export interface AdminProviderRuntimeSlice {
  readonly app: ProviderAppDependencies;
  readonly workerFleetEvidence: Pick<
    PrismaWorkerFleetReadRepository,
    "listRunningRuns" | "listSchedules"
  >;
  readonly operationalHealthRepository: OperationalHealthRepository;
  readonly machineryAlertFacts: MachineryAlertFactsSource;
  close(): Promise<void>;
}

export interface AdminProviderRuntimeFactoryContext {
  readonly central: CentralPrismaClient;
  readonly environment: NodeJS.ProcessEnv;
  readonly actorPseudonymKey: Uint8Array;
  readonly sourceAdministration: SourceAdministrationSettings | null;
  readonly recomputationBacklogLimit: number;
  readonly catalogDeploymentKey: string | null;
}

export type AdminProviderRuntimeFactory = (
  context: AdminProviderRuntimeFactoryContext,
) => Promise<AdminProviderRuntimeSlice> | AdminProviderRuntimeSlice;

export interface CreateAdminRuntimeInput {
  readonly environment?: NodeJS.ProcessEnv;
  /** Adapter-validated listening port for self-hosted process models. */
  readonly port?: number;
  /**
   * Provider-local admin behavior is supplied by the distributed routing
   * composition. Keeping it explicit prevents a legacy database fallback.
   */
  readonly providerRuntimeFactory?: AdminProviderRuntimeFactory;
  /**
   * Vercel terminates the public connection one trusted hop before Express and
   * overwrites the forwarded-for header. The deployment adapter opts into that
   * single hop; self-hosted processes continue to require explicit CIDRs.
   */
  readonly trustedProxyHops?: number;
}

/**
 * Composes the admin's database-backed behavior without choosing a process
 * model. Central dependencies are authoritative in `packscout`; provider-local
 * dependencies must arrive through the validated provider routing factory.
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
  if (input.providerRuntimeFactory === undefined) {
    throw new Error(
      "PackScout provider runtime composition is required; legacy database fallback is disabled.",
    );
  }

  const centralDatabaseUrl = readRequiredSecret(
    environment.PACKSCOUT_CONTROL_DATABASE_URL,
    "PACKSCOUT_CONTROL_DATABASE_URL",
  );
  const sessionSecret = readRequiredSecret(
    environment.PACKSCOUT_SESSION_HASHING_SECRET,
    "PACKSCOUT_SESSION_HASHING_SECRET",
    32,
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
  const centralLifecycle = createCentralDatabaseLifecycle({
    databaseUrl: centralDatabaseUrl,
  });
  let providerRuntime: AdminProviderRuntimeSlice | undefined;

  try {
    await centralLifecycle.start();
    const central = centralLifecycle.client;
    providerRuntime = await input.providerRuntimeFactory({
      central,
      environment,
      actorPseudonymKey: providerActorKey,
      sourceAdministration,
      recomputationBacklogLimit,
      catalogDeploymentKey,
    });
    const operational = createAdminCentralOperationalRuntime({
      database: central,
      actorPseudonymKey: providerActorKey,
      healthRepository: providerRuntime.operationalHealthRepository,
      alertEmail: { env: environment },
    });
    if (operational.health === undefined) {
      throw new Error("PackScout provider health composition is required.");
    }
    const auth = await createAdminAuthRuntime({
      repository: new CentralAuthRepository(central),
      loginLimiter: new CentralLoginAttemptLimiter(central, {
        windowMs: 15 * 60 * 1_000,
        blockMs: 15 * 60 * 1_000,
        maximumFailures: 8,
      }),
      audit: new CentralAuthAuditSink(central),
      sessionSecret,
      sessionIdleMs,
      sessionAbsoluteMs,
      production: !development,
      allowedOrigins,
    });
    const directory = withProductUserProfiles(
      createProductUserDirectoryReader({ config: productUserDirectoryConfig }),
      createPrivyProductUserProfileReader({
        appId: environment.PRIVY_APP_ID,
        appSecret: environment.PRIVY_APP_SECRET,
      }),
    );
    const publishedCatalog = createPublishedCatalogReader({
      config: productUserDirectoryConfig,
    });
    const app = createAdminApp({
      trustedProxies: configuredTrustedProxies,
      trustedProxyHops: input.trustedProxyHops,
      auth,
      providers: createCentralProviderAdminRuntime(central),
      ...providerRuntime.app,
      workerFleet: createDistributedAdminWorkerFleetRuntime({
        presence: new CentralWorkerPresenceRepository(central),
        evidence: providerRuntime.workerFleetEvidence,
      }),
      published: publishedCatalog,
      productUsers: {
        directory,
        audit: createProductUserAuditSink({
          database: central,
          actorPseudonymKey: providerActorKey,
        }),
        decisionNotice: createAdminAccessDecisionNoticeRuntime({
          database: central,
          directory,
        }),
      },
      betaAllowlist: {
        directory: createBetaAllowlistDirectoryClient({
          config: productUserDirectoryConfig,
        }),
        audit: createBetaAllowlistAuditSink({
          database: central,
          actorPseudonymKey: providerActorKey,
        }),
      },
      operationalAlerts: { alerts: operational.alerts },
      operationalHealth: { health: operational.health },
      sourceAdministrationUnconfigured: sourceAdministration === null,
      messages: createAdminMessageDeliveryRuntime({
        database: central,
        actorPseudonymKey: providerActorKey,
      }),
      passwordReset:
        emailLinkTokenSecret === null
          ? undefined
          : createAdminPasswordResetRuntime({
              database: central,
              authService: auth.service,
              secret: emailLinkTokenSecret,
            }),
      operatorInvitations:
        emailLinkTokenSecret === null
          ? undefined
          : createAdminOperatorInvitationRuntime({
              database: central,
              authService: auth.service,
              secret: emailLinkTokenSecret,
            }),
      operatorAccountCreatedNotifier:
        createAdminOperatorAccountCreatedNoticeRuntime({ database: central }),
    });
    const machineryAlerts = new MachineryAlertService(
      providerRuntime.machineryAlertFacts,
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
        closePromise ??= (async () => {
          let firstError: unknown;
          try {
            await providerRuntime?.close();
          } catch (error) {
            firstError = error;
          }
          try {
            await centralLifecycle.close();
          } catch (error) {
            firstError ??= error;
          }
          if (firstError !== undefined) throw firstError;
        })();
        return closePromise;
      },
    };
  } catch (error) {
    await providerRuntime?.close().catch(() => undefined);
    await centralLifecycle.close().catch(() => undefined);
    throw error;
  }
}
