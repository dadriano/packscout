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

interface ProcessImmediateDeliveryLifecycle {
  start(): Promise<void>;
  stop(): Promise<void> | void;
}

type ProcessRuntimeComposition = Readonly<{
  runtime: ProcessRuntime;
  immediateDelivery: ProcessImmediateDeliveryLifecycle;
}>;

function runtimeComposition(
  value: ProcessRuntime | ProcessRuntimeComposition,
): Readonly<{
  runtime: ProcessRuntime;
  immediateDelivery: ProcessImmediateDeliveryLifecycle | null;
}> {
  return "runtime" in value
    ? value
    : { runtime: value, immediateDelivery: null };
}

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
    result.reconciliationFailures > 0 ||
    result.stateReadFailures > 0 ||
    result.invocations.some(({ state }) => state === "failed")
  ) throw new DistributedPromotionJobProcessInvocationError();
}

/** Owns one role-scoped database client and one role-scoped runtime process. */
export async function runDistributedPromotionJobProcess<TClient>(
  input: Readonly<{
    configuration: DistributedPromotionJobProcessConfiguration;
    database: DistributedPromotionJobProcessLifecycle<TClient>;
    createRuntime: (
      client: TClient,
    ) => ProcessRuntime | ProcessRuntimeComposition;
    signals?: DistributedPromotionJobProcessSignalPort;
  }>,
): Promise<void> {
  let runtime: ProcessRuntime | null = null;
  let immediateDelivery: ProcessImmediateDeliveryLifecycle | null = null;
  let immediateDeliveryStopPromise: Promise<void> | null = null;
  const signals = input.signals ?? process;
  const stopImmediateDelivery = (): Promise<void> => {
    immediateDeliveryStopPromise ??=
      Promise.resolve(immediateDelivery?.stop()).catch(() => undefined);
    return immediateDeliveryStopPromise;
  };
  const requestStop = () => {
    runtime?.stop();
    void stopImmediateDelivery();
  };
  try {
    await input.database.start();
    const composed = runtimeComposition(
      input.createRuntime(input.database.client),
    );
    runtime = composed.runtime;
    immediateDelivery = composed.immediateDelivery;
    if (input.configuration.mode === "daemon") {
      signals.once("SIGINT", requestStop);
      signals.once("SIGTERM", requestStop);
      try {
        // LISTEN/notification delivery is only a latency optimization. A
        // failed subscription cannot disable the durable polling schedule.
        await immediateDelivery?.start().catch(() => undefined);
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
    await stopImmediateDelivery();
    await input.database.close();
  }
}
