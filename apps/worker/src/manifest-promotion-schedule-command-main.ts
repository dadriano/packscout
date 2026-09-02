import {
  createCentralDatabaseLifecycle,
  PrismaManifestReconciliationJobRepository,
  type CentralDatabaseLifecycle,
} from "@packscout/database";
import {
  PromotionJobScheduleCommandConfigurationError,
  readManifestPromotionScheduleCommandConfiguration,
} from "./promotion-job-schedule-command-config.ts";
import {
  PROMOTION_JOB_SCHEDULE_COMMAND_SCHEMA,
  PromotionJobScheduleCommandError,
  runPromotionJobScheduleCommand,
} from "./promotion-job-schedule-command.ts";

const SAFE_UNAVAILABLE_CODE =
  "MANIFEST_PROMOTION_SCHEDULE_COMMAND_UNAVAILABLE";

async function main(): Promise<void> {
  let database: CentralDatabaseLifecycle | undefined;
  try {
    const configuration =
      readManifestPromotionScheduleCommandConfiguration(process.env);
    database = createCentralDatabaseLifecycle({
      databaseUrl: configuration.databaseUrl,
      connectionLimit: 1,
    });
    await database.start();
    const output = await runPromotionJobScheduleCommand({
      configuration,
      repository: new PrismaManifestReconciliationJobRepository(
        database.client,
      ),
    });
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    const failureCode =
      error instanceof PromotionJobScheduleCommandConfigurationError ||
      error instanceof PromotionJobScheduleCommandError
        ? error.code
        : SAFE_UNAVAILABLE_CODE;
    process.stderr.write(`${JSON.stringify({
      schemaVersion: PROMOTION_JOB_SCHEDULE_COMMAND_SCHEMA,
      status: "schedule_command_failed",
      failureCode,
    })}\n`);
    process.exitCode = 1;
  } finally {
    await database?.close().catch(() => undefined);
  }
}

void main();
