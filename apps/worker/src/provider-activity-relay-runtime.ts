import type {
  ProviderActivityRelayCycleResult,
} from "./provider-activity-relay.ts";

export const PROVIDER_ACTIVITY_RELAY_DEFAULT_POLL_MS = 1_000;

export interface ProviderActivityRelayRuntimeCoordinator {
  runCycle(): Promise<ProviderActivityRelayCycleResult>;
}

export interface ProviderActivityRelayRuntimeLogger {
  log(record: Readonly<{
    level: "info" | "warning";
    event: "provider_activity_relay_runtime";
    phase: "started" | "cycle" | "stopped";
    outcome: "running" | "completed" | "degraded" | "failed" | "stopped";
    failureCode: string | null;
    providers: number | null;
    delivered: number | null;
    deduplicated: number | null;
    unreachable: number | null;
    failures: number | null;
    backpressured: number | null;
  }>): void;
}

export interface ProviderActivityRelayRuntimeCycleResult {
  readonly state: "completed" | "degraded" | "failed";
  readonly failureCode: string | null;
  readonly result: ProviderActivityRelayCycleResult | null;
}

function boundedPollMilliseconds(value: number | undefined): number {
  const resolved = value ?? PROVIDER_ACTIVITY_RELAY_DEFAULT_POLL_MS;
  if (!Number.isInteger(resolved) || resolved < 100 || resolved > 60_000) {
    throw new RangeError("Provider activity relay poll cadence is invalid.");
  }
  return resolved;
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function classify(
  result: ProviderActivityRelayCycleResult,
): Omit<ProviderActivityRelayRuntimeCycleResult, "result"> {
  if (result.providers === 0 && result.failures > 0) {
    return {
      state: "failed",
      failureCode: "PROVIDER_ACTIVITY_RELAY_DIRECTORY_UNAVAILABLE",
    };
  }
  if (result.failures > 0) {
    return {
      state: "degraded",
      failureCode: "PROVIDER_ACTIVITY_RELAY_DELIVERY_PENDING",
    };
  }
  if (result.unreachable > 0 || result.backpressured > 0) {
    return {
      state: "degraded",
      failureCode: "PROVIDER_ACTIVITY_RELAY_PROVIDER_UNAVAILABLE",
    };
  }
  return { state: "completed", failureCode: null };
}

/** Low-latency host for the bounded, cursor-based relay coordinator. */
export class ProviderActivityRelayRuntime {
  readonly #pollMilliseconds: number;
  readonly #sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly #controller = new AbortController();
  #activeCycle: Promise<ProviderActivityRelayRuntimeCycleResult> | null = null;
  #running: Promise<void> | null = null;

  constructor(private readonly dependencies: Readonly<{
    coordinator: ProviderActivityRelayRuntimeCoordinator;
    logger: ProviderActivityRelayRuntimeLogger;
    pollMilliseconds?: number;
    sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  }>) {
    this.#pollMilliseconds = boundedPollMilliseconds(
      dependencies.pollMilliseconds,
    );
    this.#sleep = dependencies.sleep ?? sleep;
  }

  start(): Promise<void> {
    if (this.#running !== null) return this.#running;
    if (this.#controller.signal.aborted) {
      return Promise.reject(new Error("Provider activity relay runtime stopped."));
    }
    this.#running = this.runLoop();
    return this.#running;
  }

  stop(): void {
    this.#controller.abort();
  }

  runOnce(): Promise<ProviderActivityRelayRuntimeCycleResult> {
    if (this.#activeCycle !== null) return this.#activeCycle;
    const cycle = this.executeCycle().finally(() => {
      if (this.#activeCycle === cycle) this.#activeCycle = null;
    });
    this.#activeCycle = cycle;
    return cycle;
  }

  private async runLoop(): Promise<void> {
    this.dependencies.logger.log({
      level: "info",
      event: "provider_activity_relay_runtime",
      phase: "started",
      outcome: "running",
      failureCode: null,
      providers: null,
      delivered: null,
      deduplicated: null,
      unreachable: null,
      failures: null,
      backpressured: null,
    });
    try {
      while (!this.#controller.signal.aborted) {
        await this.runOnce();
        if (this.#controller.signal.aborted) break;
        await this.#sleep(
          this.#pollMilliseconds,
          this.#controller.signal,
        );
      }
    } finally {
      this.dependencies.logger.log({
        level: "info",
        event: "provider_activity_relay_runtime",
        phase: "stopped",
        outcome: "stopped",
        failureCode: null,
        providers: null,
        delivered: null,
        deduplicated: null,
        unreachable: null,
        failures: null,
        backpressured: null,
      });
    }
  }

  private async executeCycle(): Promise<ProviderActivityRelayRuntimeCycleResult> {
    try {
      const result = await this.dependencies.coordinator.runCycle();
      const classification = classify(result);
      this.dependencies.logger.log({
        level: classification.state === "completed" ? "info" : "warning",
        event: "provider_activity_relay_runtime",
        phase: "cycle",
        outcome: classification.state,
        failureCode: classification.failureCode,
        ...result,
      });
      return { ...classification, result };
    } catch {
      const failureCode = "PROVIDER_ACTIVITY_RELAY_CYCLE_FAILED";
      this.dependencies.logger.log({
        level: "warning",
        event: "provider_activity_relay_runtime",
        phase: "cycle",
        outcome: "failed",
        failureCode,
        providers: null,
        delivered: null,
        deduplicated: null,
        unreachable: null,
        failures: null,
        backpressured: null,
      });
      return { state: "failed", failureCode, result: null };
    }
  }
}

export class JsonConsoleProviderActivityRelayRuntimeLogger
implements ProviderActivityRelayRuntimeLogger {
  log(record: Parameters<ProviderActivityRelayRuntimeLogger["log"]>[0]): void {
    const serialized = JSON.stringify(record);
    if (record.level === "warning") console.warn(serialized);
    else console.info(serialized);
  }
}
