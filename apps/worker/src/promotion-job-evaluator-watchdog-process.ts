import type {
  PromotionJobEvaluatorWatchdogResponse,
} from "@packscout/services";
import type {
  PromotionJobEvaluatorObservationSink,
} from "./promotion-job-system-condition-webhook.ts";

const UNAVAILABLE_RECORD = Object.freeze({
  state: "unavailable",
  failureCode: "PROMOTION_JOB_EVALUATOR_WATCHDOG_UNAVAILABLE",
});
const SYSTEM_SINK_UNAVAILABLE_RECORD = Object.freeze({
  state: "unavailable",
  failureCode: "PROMOTION_JOB_EVALUATOR_WATCHDOG_SYSTEM_SINK_UNAVAILABLE",
});

export interface PromotionJobEvaluatorWatchdogProcessDatabase {
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface PromotionJobEvaluatorWatchdogProcessBoundary {
  inspect(): Promise<PromotionJobEvaluatorWatchdogResponse>;
}

export interface PromotionJobEvaluatorWatchdogProcessOutput {
  write(value: string): unknown;
}

function writeRecord(
  output: PromotionJobEvaluatorWatchdogProcessOutput,
  value: unknown,
): void {
  output.write(`${JSON.stringify(value)}\n`);
}

/**
 * Runs the least-authority evaluator detector once. Exit 2 means the detector
 * has proved three missed windows; exit 1 means the detector or its external
 * system-condition delivery is unavailable. All other judgments exit zero.
 */
export async function runPromotionJobEvaluatorWatchdogProcess(
  input: Readonly<{
    database: PromotionJobEvaluatorWatchdogProcessDatabase;
    boundary: PromotionJobEvaluatorWatchdogProcessBoundary;
    systemConditionSink: PromotionJobEvaluatorObservationSink;
    stdout?: PromotionJobEvaluatorWatchdogProcessOutput;
    stderr?: PromotionJobEvaluatorWatchdogProcessOutput;
  }>,
): Promise<0 | 1 | 2> {
  const stdout = input.stdout ?? process.stdout;
  const stderr = input.stderr ?? process.stderr;
  let exitCode: 0 | 1 | 2 = 0;
  let failureWritten = false;
  try {
    await input.database.start();
    const response = await input.boundary.inspect();
    writeRecord(stdout, response);
    const delivered = await input.systemConditionSink
      .publishEvaluatorObservation(response);
    if (delivered.state !== "delivered") {
      writeRecord(stderr, SYSTEM_SINK_UNAVAILABLE_RECORD);
      failureWritten = true;
      exitCode = 1;
    } else if (response.health === "alerting") {
      exitCode = 2;
    }
  } catch {
    writeRecord(stderr, UNAVAILABLE_RECORD);
    failureWritten = true;
    exitCode = 1;
  } finally {
    try {
      await input.database.close();
    } catch {
      if (!failureWritten) writeRecord(stderr, UNAVAILABLE_RECORD);
      exitCode = 1;
    }
  }
  return exitCode;
}
