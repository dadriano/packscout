import { providerSourceControlPlaneRetry } from "@packscout/contracts";

export type ControlPlaneFailureCode =
  | "cancelled"
  | "connection"
  | "deadlock"
  | "invariant"
  | "lost_ownership"
  | "serialization"
  | "stale_fence"
  | "timeout";

const transientFailureCodes: ReadonlySet<ControlPlaneFailureCode> = new Set([
  "connection",
  "deadlock",
  "serialization",
  "timeout",
]);

export class ControlPlaneTransactionError extends Error {
  readonly code: ControlPlaneFailureCode;

  constructor(code: ControlPlaneFailureCode) {
    super(`control_plane.${code}`);
    this.name = "ControlPlaneTransactionError";
    this.code = code;
  }
}

export class ControlPlaneRetryExhaustedError extends Error {
  constructor() {
    super("control_plane.retry_exhausted");
    this.name = "ControlPlaneRetryExhaustedError";
  }
}

export class RuntimeLocallyFencedError extends Error {
  constructor() {
    super("control_plane.runtime_locally_fenced");
    this.name = "RuntimeLocallyFencedError";
  }
}

export class RuntimeControlPlaneFence {
  readonly #controller = new AbortController();
  #state: "active" | "fenced_draining" = "active";

  get state(): "active" | "fenced_draining" {
    return this.#state;
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  assertActive(): void {
    if (this.#state !== "active") throw new RuntimeLocallyFencedError();
  }

  fence(): void {
    if (this.#state === "fenced_draining") return;
    this.#state = "fenced_draining";
    this.#controller.abort();
  }
}

export interface ControlPlaneTransactionContext {
  readonly attempt: number;
  readonly timeoutMilliseconds: number;
  readonly signal: AbortSignal;
}

export interface RunControlPlaneTransactionInput<TResult> {
  readonly runtimeFence: RuntimeControlPlaneFence;
  readonly revalidate: (attempt: number) => void | Promise<void>;
  readonly transact: (
    context: ControlPlaneTransactionContext,
  ) => TResult | Promise<TResult>;
  readonly onExhausted: () => void | Promise<void>;
  /** Observability-only work may leave the runtime active for a later retry. */
  readonly fenceOnExhausted?: boolean;
  /** Records the exact boundary before the shared fence aborts sibling work. */
  readonly beforeFence?: () => void;
  readonly classifyFailure?: (error: unknown) => ControlPlaneFailureCode;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

function defaultFailureClassifier(error: unknown): ControlPlaneFailureCode {
  return error instanceof ControlPlaneTransactionError ? error.code : "invariant";
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runBeforeDeadline<TResult>(input: {
  readonly operation: (signal: AbortSignal) => TResult | Promise<TResult>;
  readonly timeoutMilliseconds: number;
  readonly parentSignal: AbortSignal;
}): Promise<TResult> {
  if (input.timeoutMilliseconds <= 0) {
    throw new ControlPlaneTransactionError("timeout");
  }
  if (input.parentSignal.aborted) {
    throw new RuntimeLocallyFencedError();
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeParentAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    const rejectForParentAbort = () => {
      controller.abort();
      reject(new RuntimeLocallyFencedError());
    };
    if (input.parentSignal.aborted) {
      rejectForParentAbort();
      return;
    }
    input.parentSignal.addEventListener("abort", rejectForParentAbort, {
      once: true,
    });
    removeParentAbort = () =>
      input.parentSignal.removeEventListener("abort", rejectForParentAbort);
    timer = setTimeout(() => {
      controller.abort();
      reject(new ControlPlaneTransactionError("timeout"));
    }, input.timeoutMilliseconds);
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        if (input.parentSignal.aborted) throw new RuntimeLocallyFencedError();
        if (controller.signal.aborted) {
          throw new ControlPlaneTransactionError("timeout");
        }
        return input.operation(controller.signal);
      }),
      deadline,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    removeParentAbort?.();
  }
}

export async function runControlPlaneTransaction<TResult>(
  input: RunControlPlaneTransactionInput<TResult>,
): Promise<TResult> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? defaultSleep;
  const classify = input.classifyFailure ?? defaultFailureClassifier;
  const startedAt = now();
  const wallClockLimit = providerSourceControlPlaneRetry.wallClockLimitMilliseconds;

  for (
    let attempt = 1;
    attempt <= providerSourceControlPlaneRetry.maximumAttempts;
    attempt += 1
  ) {
    const delay = providerSourceControlPlaneRetry.backoffMilliseconds[attempt - 1]!;
    if (delay > 0) {
      const remainingBeforeSleep = wallClockLimit - (now() - startedAt);
      try {
        await runBeforeDeadline({
          operation: () => sleep(delay),
          timeoutMilliseconds: remainingBeforeSleep,
          parentSignal: input.runtimeFence.signal,
        });
      } catch (error) {
        if (error instanceof RuntimeLocallyFencedError) throw error;
        const code = error instanceof ControlPlaneTransactionError
          ? error.code
          : classify(error);
        if (!transientFailureCodes.has(code)) throw error;
        if (attempt === providerSourceControlPlaneRetry.maximumAttempts) break;
        continue;
      }
    }
    input.runtimeFence.assertActive();
    const remainingBeforeRevalidation = wallClockLimit - (now() - startedAt);
    if (remainingBeforeRevalidation <= 0) {
      break;
    }
    try {
      await runBeforeDeadline({
        operation: () => input.revalidate(attempt),
        timeoutMilliseconds: remainingBeforeRevalidation,
        parentSignal: input.runtimeFence.signal,
      });
    } catch (error) {
      if (error instanceof RuntimeLocallyFencedError) throw error;
      const code = error instanceof ControlPlaneTransactionError
        ? error.code
        : classify(error);
      if (!transientFailureCodes.has(code)) throw error;
      if (attempt === providerSourceControlPlaneRetry.maximumAttempts) break;
      continue;
    }
    input.runtimeFence.assertActive();
    const remainingWallClock = wallClockLimit - (now() - startedAt);
    if (remainingWallClock <= 0) break;
    try {
      const attemptTimeout = Math.min(
        providerSourceControlPlaneRetry.transactionTimeoutMilliseconds,
        remainingWallClock,
      );
      return await runBeforeDeadline({
        operation: (signal) => input.transact({
          attempt,
          timeoutMilliseconds: attemptTimeout,
          signal,
        }),
        timeoutMilliseconds: attemptTimeout,
        parentSignal: input.runtimeFence.signal,
      });
    } catch (error) {
      if (error instanceof RuntimeLocallyFencedError) throw error;
      const code = error instanceof ControlPlaneTransactionError
        ? error.code
        : classify(error);
      if (!transientFailureCodes.has(code)) throw error;
      if (attempt === providerSourceControlPlaneRetry.maximumAttempts) break;
    }
  }

  if (input.fenceOnExhausted !== false) {
    input.beforeFence?.();
    input.runtimeFence.fence();
  }
  await input.onExhausted();
  throw new ControlPlaneRetryExhaustedError();
}
