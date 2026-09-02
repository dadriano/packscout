import type {
  DistributedPromotionJobProcessConfiguration,
} from "./distributed-promotion-job-process-types.ts";
import type {
  DistributedPromotionJobRuntime,
  DistributedPromotionRuntimeCycleResult,
  DistributedPromotionRuntimeInvocationResult,
} from "./distributed-promotion-job-runtime.ts";

type ProcessRuntime = Pick<
  DistributedPromotionJobRuntime,
  "start" | "stop" | "runCycle" | "runManual" | "runContinuation"
>;

export interface DistributedPromotionJobProcessLifecycle<TClient> {
  readonly client: TClient;
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface DistributedPromotionJobProcessSignalPort {
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export class DistributedPromotionJobProcessInvocationError extends Error {
  readonly code = "DISTRIBUTED_PROMOTION_PROCESS_INVOCATION_FAILED";

  constructor() {
    super("Distributed promotion process invocation failed.");
    this.name = "DistributedPromotionJobProcessInvocationError";
  }
}

function assertInvocation(
  result: DistributedPromotionRuntimeInvocationResult,
): void {
  if (result.state === "failed") {
    throw new DistributedPromotionJobProcessInvocationError();
  }
}

function assertCycle(result: DistributedPromotionRuntimeCycleResult): void {
  if (
    result.stateReadFailures > 0 ||
    result.invocations.some(({ state }) => state === "failed")
  ) throw new DistributedPromotionJobProcessInvocationError();
}

/** Owns one role-scoped database client and one role-scoped runtime process. */
export async function runDistributedPromotionJobProcess<TClient>(
  input: Readonly<{
    configuration: DistributedPromotionJobProcessConfiguration;
    database: DistributedPromotionJobProcessLifecycle<TClient>;
    createRuntime: (client: TClient) => ProcessRuntime;
    signals?: DistributedPromotionJobProcessSignalPort;
  }>,
): Promise<void> {
  let runtime: ProcessRuntime | null = null;
  const signals = input.signals ?? process;
  const requestStop = () => runtime?.stop();
  try {
    await input.database.start();
    runtime = input.createRuntime(input.database.client);
    if (input.configuration.mode === "daemon") {
      signals.once("SIGINT", requestStop);
      signals.once("SIGTERM", requestStop);
      try {
        await runtime.start();
      } finally {
        signals.removeListener("SIGINT", requestStop);
        signals.removeListener("SIGTERM", requestStop);
      }
      return;
    }
    if (input.configuration.mode === "once") {
      assertCycle(await runtime.runCycle());
      return;
    }
    if (input.configuration.mode === "manual") {
      assertInvocation(await runtime.runManual(
        input.configuration.manualCommandIdentity!,
      ));
      return;
    }
    assertInvocation(await runtime.runContinuation(
      input.configuration.continuationGeneration!,
    ));
  } finally {
    runtime?.stop();
    await input.database.close();
  }
}
