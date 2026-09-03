import {
  createProviderDatabaseLifecycle,
  PrismaProviderPromotionJobRepository,
  type ProviderDatabaseLifecycle,
} from "@packscout/database";
import {
  PromotionJobScheduleCommandConfigurationError,
  readProviderPromotionScheduleCommandConfiguration,
} from "./promotion-job-schedule-command-config.ts";
import {
  PROMOTION_JOB_SCHEDULE_COMMAND_SCHEMA,
  PromotionJobScheduleCommandError,
  runPromotionJobScheduleCommand,
} from "./promotion-job-schedule-command.ts";

const SAFE_UNAVAILABLE_CODE =
  "PROVIDER_PROMOTION_SCHEDULE_COMMAND_UNAVAILABLE";

async function main(): Promise<void> {
  let database: ProviderDatabaseLifecycle | undefined;
  try {
    const configuration =
      readProviderPromotionScheduleCommandConfiguration(process.env);
    database = createProviderDatabaseLifecycle({
      databaseUrl: configuration.databaseUrl,
      providerId: configuration.providerId,
      providerKey: configuration.providerKey,
      connectionLimit: 1,
    });
    await database.start();
    const output = await runPromotionJobScheduleCommand({
      configuration,
      repository: new PrismaProviderPromotionJobRepository(database.client),
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
