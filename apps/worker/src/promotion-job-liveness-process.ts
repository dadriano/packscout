import type {
  PromotionJobLivenessProcessMode,
} from "./promotion-job-liveness-process-config.ts";
import type {
  PromotionJobLivenessRuntime,
  PromotionJobLivenessRuntimeCycleResult,
} from "./promotion-job-liveness-runtime.ts";

type RuntimePort = Pick<PromotionJobLivenessRuntime, "start" | "stop" | "runOnce">;

export interface PromotionJobLivenessProcessDatabase<TClient> {
  readonly client: TClient;
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface PromotionJobLivenessProcessGateway {
  close(): Promise<void>;
}

export interface PromotionJobLivenessProcessSignals {
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export class PromotionJobLivenessProcessRunError extends Error {
  readonly code = "PROMOTION_JOB_LIVENESS_PROCESS_FAILED";

  constructor() {
    super("Promotion job liveness process failed.");
    this.name = "PromotionJobLivenessProcessRunError";
  }
}

export async function runPromotionJobLivenessProcess<TClient>(input: Readonly<{
  mode: PromotionJobLivenessProcessMode;
  database: PromotionJobLivenessProcessDatabase<TClient>;
  gateway: PromotionJobLivenessProcessGateway;
  createRuntime: (client: TClient) => RuntimePort;
  signals?: PromotionJobLivenessProcessSignals;
}>): Promise<void> {
  const signals = input.signals ?? process;
  let runtime: RuntimePort | null = null;
  let failure: unknown;
  const requestStop = () => {
    try {
      runtime?.stop();
    } catch {
      // Signal callbacks cannot await or safely surface dependency detail. The
      // owned shutdown path below retries stop and closes both DB capabilities.
    }
  };
  try {
    await input.database.start();
    runtime = input.createRuntime(input.database.client);
    if (input.mode === "once") {
      const result: PromotionJobLivenessRuntimeCycleResult =
        await runtime.runOnce();
      if (result.state === "failed") {
        throw new PromotionJobLivenessProcessRunError();
      }
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
  } catch (error) {
    failure = error;
  } finally {
    try {
      runtime?.stop();
    } catch {
      failure ??= new PromotionJobLivenessProcessRunError();
    }
    try {
      await input.gateway.close();
    } catch {
      failure ??= new PromotionJobLivenessProcessRunError();
    }
    try {
      await input.database.close();
    } catch {
      failure ??= new PromotionJobLivenessProcessRunError();
    }
  }
  if (failure !== undefined) throw failure;
}
