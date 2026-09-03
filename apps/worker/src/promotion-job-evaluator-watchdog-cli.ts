import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createCentralDatabaseLifecycle } from "@packscout/database";
import {
  createPromotionJobEvaluatorWatchdogBoundary,
} from "./promotion-job-evaluator-watchdog-composition.ts";
import {
  readPromotionJobEvaluatorWatchdogConfiguration,
} from "./promotion-job-evaluator-watchdog-config.ts";
import {
  runPromotionJobEvaluatorWatchdogProcess,
} from "./promotion-job-evaluator-watchdog-process.ts";
import { PromotionJobSystemConditionWebhook } from
  "./promotion-job-system-condition-webhook.ts";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
dotenv.config({ path: path.join(workspaceRoot, ".env") });

async function main(): Promise<void> {
  const configuration = readPromotionJobEvaluatorWatchdogConfiguration(
    process.env,
  );
  const database = createCentralDatabaseLifecycle({
    databaseUrl: configuration.databaseUrl,
    connectionLimit: 1,
  });
  process.exitCode = await runPromotionJobEvaluatorWatchdogProcess({
    database,
    boundary: createPromotionJobEvaluatorWatchdogBoundary(database.client),
    systemConditionSink: new PromotionJobSystemConditionWebhook(
      configuration.systemSink,
    ),
  });
}

main().catch(() => {
  process.stderr.write(`${JSON.stringify({
    state: "unavailable",
    failureCode: "PROMOTION_JOB_EVALUATOR_WATCHDOG_UNAVAILABLE",
  })}\n`);
  process.exitCode = 1;
});
