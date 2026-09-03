import assert from "node:assert/strict";
import test from "node:test";
import type {
  ActivatePromotionJobScheduleInput,
  PausePromotionJobScheduleInput,
  PromotionJobSchedule,
} from "@packscout/database";
import {
  readManifestPromotionScheduleCommandConfiguration,
  readProviderPromotionScheduleCommandConfiguration,
} from "./promotion-job-schedule-command-config.ts";
import {
  type PromotionJobScheduleCommandRepository,
  runPromotionJobScheduleCommand,
} from "./promotion-job-schedule-command.ts";

const PROVIDER_ID = "00000000-0000-4000-8000-000000000551";
const BASELINE = new Date("2026-09-01T12:00:00.000Z");
const ACTIVATED = new Date("2026-09-01T12:00:01.000Z");

function schedule(input: Partial<PromotionJobSchedule> = {}): PromotionJobSchedule {
  return {
    authority: "provider_publication",
    lifecycle: "pending_activation",
    scheduleEpoch: 0n,
    cadenceSeconds: 60,
    baselineAt: null,
    activatedAt: null,
    pausedAt: null,
    lastAdmittedWindowIndex: null,
    lastScheduledCheckinAt: null,
    nextExpectedCheckinAt: null,
    ...input,
  };
}

class ScheduleRepository implements PromotionJobScheduleCommandRepository {
  readonly activations: ActivatePromotionJobScheduleInput[] = [];
  readonly pauses: PausePromotionJobScheduleInput[] = [];

  constructor(public current: PromotionJobSchedule) {}

  async loadSchedule(): Promise<PromotionJobSchedule> {
    return this.current;
  }

  async activateSchedule(
    input: ActivatePromotionJobScheduleInput,
  ): Promise<PromotionJobSchedule> {
    this.activations.push(input);
    this.current = schedule({
      authority: this.current.authority,
      lifecycle: "active",
      scheduleEpoch: input.scheduleEpoch,
      baselineAt: input.baselineAt,
      activatedAt: input.activatedAt,
      nextExpectedCheckinAt: new Date(input.baselineAt.getTime() + 60_000),
    });
    return this.current;
  }

  async pauseSchedule(
    input: PausePromotionJobScheduleInput,
  ): Promise<PromotionJobSchedule> {
    this.pauses.push(input);
    this.current = {
      ...this.current,
      lifecycle: "paused",
      pausedAt: input.pausedAt,
      nextExpectedCheckinAt: null,
    };
    return this.current;
  }
}

function activationEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    PACKSCOUT_PROMOTION_SCHEDULE_COMMAND_ENVIRONMENT: "production",
    PACKSCOUT_PROMOTION_SCHEDULE_COMMAND_ACTION: "activate",
    PACKSCOUT_PROMOTION_SCHEDULE_EXPECTED_LIFECYCLE: "pending_activation",
    PACKSCOUT_PROMOTION_SCHEDULE_EXPECTED_EPOCH: "0",
    PACKSCOUT_PROMOTION_SCHEDULE_EXPECTED_BASELINE_AT: "none",
    PACKSCOUT_PROMOTION_SCHEDULE_EXPECTED_ACTIVATED_AT: "none",
    PACKSCOUT_PROMOTION_SCHEDULE_EXPECTED_PAUSED_AT: "none",
    PACKSCOUT_PROMOTION_SCHEDULE_EFFECTIVE_AT: ACTIVATED.toISOString(),
    PACKSCOUT_PROMOTION_SCHEDULE_ACTIVATION_BASELINE_AT: BASELINE.toISOString(),
    PACKSCOUT_PROVIDER_PROMOTION_SCHEDULE_DATABASE_URL:
      "postgresql://schedule:secret@provider.example/packscout_alpha",
    PACKSCOUT_PROVIDER_PROMOTION_SCHEDULE_PROVIDER_ID: PROVIDER_ID,
    PACKSCOUT_PROVIDER_PROMOTION_SCHEDULE_PROVIDER_KEY: "alpha",
  };
}

function pauseEnvironment(): NodeJS.ProcessEnv {
  return {
    ...activationEnvironment(),
    PACKSCOUT_PROMOTION_SCHEDULE_COMMAND_ACTION: "pause",
    PACKSCOUT_PROMOTION_SCHEDULE_EXPECTED_LIFECYCLE: "active",
    PACKSCOUT_PROMOTION_SCHEDULE_EXPECTED_EPOCH: "4",
    PACKSCOUT_PROMOTION_SCHEDULE_EXPECTED_BASELINE_AT: BASELINE.toISOString(),
    PACKSCOUT_PROMOTION_SCHEDULE_EXPECTED_ACTIVATED_AT: ACTIVATED.toISOString(),
    PACKSCOUT_PROMOTION_SCHEDULE_EFFECTIVE_AT:
      "2026-09-01T12:05:00.000Z",
    PACKSCOUT_PROMOTION_SCHEDULE_ACTIVATION_BASELINE_AT: "none",
  };
}

test("activates one provider schedule at the next epoch and fixed cadence", async () => {
  const configuration =
    readProviderPromotionScheduleCommandConfiguration(activationEnvironment());
  const repository = new ScheduleRepository(schedule());
  const output = await runPromotionJobScheduleCommand({
    configuration,
    repository,
  });

  assert.equal(output.disposition, "changed");
  assert.equal(output.authority, "provider_publication");
  assert.equal(output.scheduleEpoch, "1");
  assert.equal(output.cadenceSeconds, 60);
  assert.equal(repository.activations.length, 1);
  assert.equal(repository.pauses.length, 0);
  assert.equal(repository.activations[0]?.scheduleEpoch, 1n);
  assert.equal(JSON.stringify(output).includes(PROVIDER_ID), false);
  assert.equal(JSON.stringify(output).includes("secret"), false);
});

test("pauses cron only and preserves the active schedule epoch", async () => {
  const configuration =
    readProviderPromotionScheduleCommandConfiguration(pauseEnvironment());
  const repository = new ScheduleRepository(schedule({
    lifecycle: "active",
    scheduleEpoch: 4n,
    baselineAt: BASELINE,
    activatedAt: ACTIVATED,
    nextExpectedCheckinAt: new Date(BASELINE.getTime() + 60_000),
  }));
  const output = await runPromotionJobScheduleCommand({
    configuration,
    repository,
  });

  assert.equal(output.lifecycle, "paused");
  assert.equal(output.scheduleEpoch, "4");
  assert.equal(repository.activations.length, 0);
  assert.equal(repository.pauses.length, 1);
  assert.deepEqual(Object.keys(repository).sort(), [
    "activations",
    "current",
    "pauses",
  ]);
});

test("retries an exact transition without another mutation", async () => {
  const configuration =
    readProviderPromotionScheduleCommandConfiguration(activationEnvironment());
  const repository = new ScheduleRepository(schedule({
    lifecycle: "active",
    scheduleEpoch: 1n,
    baselineAt: BASELINE,
    activatedAt: ACTIVATED,
    lastAdmittedWindowIndex: 3n,
    lastScheduledCheckinAt: new Date("2026-09-01T12:03:01.000Z"),
    nextExpectedCheckinAt: new Date("2026-09-01T12:04:00.000Z"),
  }));
  const output = await runPromotionJobScheduleCommand({
    configuration,
    repository,
  });

  assert.equal(output.disposition, "existing");
  assert.equal(repository.activations.length, 0);
  assert.equal(repository.pauses.length, 0);
});

test("refuses a stale exact baseline before mutation", async () => {
  const configuration =
    readProviderPromotionScheduleCommandConfiguration(pauseEnvironment());
  const repository = new ScheduleRepository(schedule({
    lifecycle: "active",
    scheduleEpoch: 5n,
    baselineAt: BASELINE,
    activatedAt: ACTIVATED,
  }));
  await assert.rejects(
    runPromotionJobScheduleCommand({ configuration, repository }),
    { code: "PROMOTION_JOB_SCHEDULE_COMMAND_BASELINE_MISMATCH" },
  );
  assert.equal(repository.activations.length, 0);
  assert.equal(repository.pauses.length, 0);
});

test("the central command accepts only the manifest authority", async () => {
  const environment = activationEnvironment();
  delete environment.PACKSCOUT_PROVIDER_PROMOTION_SCHEDULE_DATABASE_URL;
  delete environment.PACKSCOUT_PROVIDER_PROMOTION_SCHEDULE_PROVIDER_ID;
  delete environment.PACKSCOUT_PROVIDER_PROMOTION_SCHEDULE_PROVIDER_KEY;
  environment.PACKSCOUT_MANIFEST_RECONCILIATION_SCHEDULE_DATABASE_URL =
    "postgresql://schedule:secret@central.example/packscout";
  const configuration =
    readManifestPromotionScheduleCommandConfiguration(environment);
  const repository = new ScheduleRepository(schedule({
    authority: "manifest_reconciliation",
  }));
  const output = await runPromotionJobScheduleCommand({
    configuration,
    repository,
  });
  assert.equal(output.authority, "manifest_reconciliation");
  assert.equal(output.providerIdentitySha256, null);
});
