import type { PackscoutPrismaClient } from "@packscout/database";
import {
  readProviderSourceSupervisorConfiguration,
  type ProviderSourceSupervisorConfiguration,
} from "./source-supervisor-runtime-config.ts";

export interface ProviderSourceSupervisorRuntimePort {
  start(): Promise<void>;
  stop(): Promise<void> | void;
}

export interface ProviderSourceSupervisorDatabaseLifecyclePort {
  readonly client: PackscoutPrismaClient;
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface ProviderSourceSupervisorSignalPort {
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface ProviderSourceSupervisorBootstrapDependencies {
  readonly createDatabaseLifecycle: (
    input: Readonly<{ databaseUrl: string }>,
  ) => ProviderSourceSupervisorDatabaseLifecyclePort;
  readonly createRuntime: (input: Readonly<{
    configuration: ProviderSourceSupervisorConfiguration;
    database: PackscoutPrismaClient;
  }>) => ProviderSourceSupervisorRuntimePort;
  readonly signals?: ProviderSourceSupervisorSignalPort;
}

/**
 * Owns configuration, database lifetime, and graceful signals for the isolated
 * source supervisor. Production wiring supplies the concrete runtime factory.
 */
export async function runProviderSourceSupervisorOnly(input: Readonly<{
  environment: NodeJS.ProcessEnv;
  fallbackWorkerId: string;
  dependencies: ProviderSourceSupervisorBootstrapDependencies;
}>): Promise<void> {
  const configuration = readProviderSourceSupervisorConfiguration(
    input.environment,
    input.fallbackWorkerId,
  );
  const database = input.dependencies.createDatabaseLifecycle({
    databaseUrl: configuration.databaseUrl,
  });
  const signals = input.dependencies.signals ?? process;
  let runtime: ProviderSourceSupervisorRuntimePort | undefined;
  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (!runtime) return Promise.resolve();
    if (!stopPromise) {
      const current = Promise.resolve(runtime.stop()).finally(() => {
        if (stopPromise === current) stopPromise = undefined;
      });
      stopPromise = current;
    }
    return stopPromise;
  };
  const requestStop = (): void => {
    // The wrapper memo resets when it settles, so a later `await stop()` may
    // never observe this copy's rejection. Sink it here; the runtime's own
    // stop failure still surfaces through the awaited stop() during shutdown.
    void stop().catch(() => {});
  };

  try {
    await database.start();
    runtime = input.dependencies.createRuntime({
      configuration,
      database: database.client,
    });
    signals.once("SIGINT", requestStop);
    signals.once("SIGTERM", requestStop);
    try {
      await runtime.start();
    } finally {
      signals.removeListener("SIGINT", requestStop);
      signals.removeListener("SIGTERM", requestStop);
      await stop();
    }
  } finally {
    await database.close();
  }
}
