import type {
  ProviderActivityRelayProcessMode,
} from "./provider-activity-relay-process-config.ts";
import type {
  ProviderActivityRelayRuntime,
  ProviderActivityRelayRuntimeCycleResult,
} from "./provider-activity-relay-runtime.ts";

type RuntimePort = Pick<
  ProviderActivityRelayRuntime,
  "start" | "stop" | "runOnce"
>;

export interface ProviderActivityRelayProcessDatabase<TClient> {
  readonly client: TClient;
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface ProviderActivityRelayProcessGateway {
  close(): Promise<void>;
}

export interface ProviderActivityRelayProcessSignals {
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export class ProviderActivityRelayProcessRunError extends Error {
  readonly code = "PROVIDER_ACTIVITY_RELAY_PROCESS_FAILED";

  constructor() {
    super("Provider activity relay process failed.");
    this.name = "ProviderActivityRelayProcessRunError";
  }
}

/** Owns central and dynamic provider connections for one isolated relay role. */
export async function runProviderActivityRelayProcess<TClient>(
  input: Readonly<{
    mode: ProviderActivityRelayProcessMode;
    database: ProviderActivityRelayProcessDatabase<TClient>;
    gateway: ProviderActivityRelayProcessGateway;
    createRuntime: (client: TClient) => RuntimePort;
    signals?: ProviderActivityRelayProcessSignals;
  }>,
): Promise<void> {
  const signals = input.signals ?? process;
  let runtime: RuntimePort | null = null;
  let failed = false;
  const requestStop = () => {
    try {
      runtime?.stop();
    } catch {
      failed = true;
    }
  };
  try {
    await input.database.start();
    runtime = input.createRuntime(input.database.client);
    if (input.mode === "once") {
      const result: ProviderActivityRelayRuntimeCycleResult =
        await runtime.runOnce();
      if (result.state === "failed") failed = true;
    } else {
      signals.once("SIGINT", requestStop);
      signals.once("SIGTERM", requestStop);
      try {
        await runtime.start();
      } finally {
        signals.removeListener("SIGINT", requestStop);
        signals.removeListener("SIGTERM", requestStop);
      }
    }
  } catch {
    failed = true;
  } finally {
    try {
      runtime?.stop();
    } catch {
      failed = true;
    }
    try {
      await input.gateway.close();
    } catch {
      failed = true;
    }
    try {
      await input.database.close();
    } catch {
      failed = true;
    }
  }
  if (failed) throw new ProviderActivityRelayProcessRunError();
}
