import { createHash } from "node:crypto";
import {
  PROMOTION_JOB_SCHEDULE_CADENCE_SECONDS,
  PromotionJobPersistenceError,
  type ActivatePromotionJobScheduleInput,
  type PausePromotionJobScheduleInput,
  type PromotionJobAuthority,
  type PromotionJobSchedule,
} from "@packscout/database";
import type {
  PromotionJobScheduleCommandConfiguration,
  PromotionJobScheduleCommandExpectedState,
} from "./promotion-job-schedule-command-config.ts";

export const PROMOTION_JOB_SCHEDULE_COMMAND_SCHEMA =
  "packscout.promotion-job-schedule-command.v1";

export type PromotionJobScheduleCommandErrorCode =
  | "PROMOTION_JOB_SCHEDULE_COMMAND_BASELINE_MISMATCH"
  | "PROMOTION_JOB_SCHEDULE_COMMAND_CONFLICT"
  | "PROMOTION_JOB_SCHEDULE_COMMAND_RESULT_INVALID";

export class PromotionJobScheduleCommandError extends Error {
  constructor(readonly code: PromotionJobScheduleCommandErrorCode) {
    super("Promotion job schedule command failed.");
    this.name = "PromotionJobScheduleCommandError";
  }
}

export interface PromotionJobScheduleCommandRepository {
  loadSchedule(): Promise<PromotionJobSchedule>;
  activateSchedule(
    input: ActivatePromotionJobScheduleInput,
  ): Promise<PromotionJobSchedule>;
  pauseSchedule(
    input: PausePromotionJobScheduleInput,
  ): Promise<PromotionJobSchedule>;
}

export interface PromotionJobScheduleCommandResult {
  readonly schemaVersion: typeof PROMOTION_JOB_SCHEDULE_COMMAND_SCHEMA;
  readonly status: "schedule_command_applied";
  readonly disposition: "changed" | "existing";
  readonly authority: PromotionJobAuthority;
  readonly providerIdentitySha256: string | null;
  readonly action: "activate" | "pause";
  readonly lifecycle: "active" | "paused";
  readonly scheduleEpoch: string;
  readonly cadenceSeconds: typeof PROMOTION_JOB_SCHEDULE_CADENCE_SECONDS;
  readonly baselineAt: string;
  readonly activatedAt: string;
  readonly pausedAt: string | null;
}

function sameInstant(left: Date | null, right: Date | null): boolean {
  return left?.getTime() === right?.getTime();
}

function sameExpectedState(
  current: PromotionJobSchedule,
  expected: PromotionJobScheduleCommandExpectedState,
): boolean {
  return current.lifecycle === expected.lifecycle &&
    current.scheduleEpoch === expected.scheduleEpoch &&
    current.cadenceSeconds === PROMOTION_JOB_SCHEDULE_CADENCE_SECONDS &&
    sameInstant(current.baselineAt, expected.baselineAt) &&
    sameInstant(current.activatedAt, expected.activatedAt) &&
    sameInstant(current.pausedAt, expected.pausedAt);
}

function sameActivationTarget(
  current: PromotionJobSchedule,
  input: Readonly<{
    scheduleEpoch: bigint;
    baselineAt: Date;
    activatedAt: Date;
  }>,
): boolean {
  return current.lifecycle === "active" &&
    current.scheduleEpoch === input.scheduleEpoch &&
    current.cadenceSeconds === PROMOTION_JOB_SCHEDULE_CADENCE_SECONDS &&
    sameInstant(current.baselineAt, input.baselineAt) &&
    sameInstant(current.activatedAt, input.activatedAt) &&
    current.pausedAt === null;
}

function samePauseTarget(
  current: PromotionJobSchedule,
  input: Readonly<{ scheduleEpoch: bigint; pausedAt: Date }>,
  expected: PromotionJobScheduleCommandExpectedState,
): boolean {
  return current.lifecycle === "paused" &&
    current.scheduleEpoch === input.scheduleEpoch &&
    current.cadenceSeconds === PROMOTION_JOB_SCHEDULE_CADENCE_SECONDS &&
    sameInstant(current.baselineAt, expected.baselineAt) &&
    sameInstant(current.activatedAt, expected.activatedAt) &&
    sameInstant(current.pausedAt, input.pausedAt);
}

function result(
  configuration: PromotionJobScheduleCommandConfiguration,
  schedule: PromotionJobSchedule,
  disposition: "changed" | "existing",
): PromotionJobScheduleCommandResult {
  if (
    schedule.authority !== configuration.authority ||
    schedule.cadenceSeconds !== PROMOTION_JOB_SCHEDULE_CADENCE_SECONDS ||
    schedule.lifecycle === "pending_activation" ||
    schedule.baselineAt === null || schedule.activatedAt === null
  ) throw new PromotionJobScheduleCommandError(
    "PROMOTION_JOB_SCHEDULE_COMMAND_RESULT_INVALID",
  );
  return Object.freeze({
    schemaVersion: PROMOTION_JOB_SCHEDULE_COMMAND_SCHEMA,
    status: "schedule_command_applied",
    disposition,
    authority: schedule.authority,
    providerIdentitySha256: configuration.authority === "provider_publication"
      ? createHash("sha256").update(configuration.providerId).digest("hex")
      : null,
    action: configuration.action,
    lifecycle: schedule.lifecycle,
    scheduleEpoch: schedule.scheduleEpoch.toString(),
    cadenceSeconds: PROMOTION_JOB_SCHEDULE_CADENCE_SECONDS,
    baselineAt: schedule.baselineAt.toISOString(),
    activatedAt: schedule.activatedAt.toISOString(),
    pausedAt: schedule.pausedAt?.toISOString() ?? null,
  });
}

/**
 * Applies exactly one authority-local schedule transition. This port cannot
 * touch wakes, invocations, another provider, or the other database role.
 */
export async function runPromotionJobScheduleCommand(input: Readonly<{
  configuration: PromotionJobScheduleCommandConfiguration;
  repository: PromotionJobScheduleCommandRepository;
}>): Promise<PromotionJobScheduleCommandResult> {
  const { configuration, repository } = input;
  const current = await repository.loadSchedule();
  if (current.authority !== configuration.authority) {
    throw new PromotionJobScheduleCommandError(
      "PROMOTION_JOB_SCHEDULE_COMMAND_BASELINE_MISMATCH",
    );
  }
  try {
    if (configuration.action === "activate") {
      const activation = Object.freeze({
        scheduleEpoch: configuration.expected.scheduleEpoch + 1n,
        baselineAt: configuration.activationBaselineAt!,
        activatedAt: configuration.effectiveAt,
      });
      if (sameActivationTarget(current, activation)) {
        return result(configuration, current, "existing");
      }
      if (!sameExpectedState(current, configuration.expected)) {
        throw new PromotionJobScheduleCommandError(
          "PROMOTION_JOB_SCHEDULE_COMMAND_BASELINE_MISMATCH",
        );
      }
      const activated = await repository.activateSchedule(activation);
      if (!sameActivationTarget(activated, activation)) {
        throw new PromotionJobScheduleCommandError(
          "PROMOTION_JOB_SCHEDULE_COMMAND_RESULT_INVALID",
        );
      }
      return result(configuration, activated, "changed");
    }
    const pause = Object.freeze({
      scheduleEpoch: configuration.expected.scheduleEpoch,
      pausedAt: configuration.effectiveAt,
    });
    if (samePauseTarget(current, pause, configuration.expected)) {
      return result(configuration, current, "existing");
    }
    if (!sameExpectedState(current, configuration.expected)) {
      throw new PromotionJobScheduleCommandError(
        "PROMOTION_JOB_SCHEDULE_COMMAND_BASELINE_MISMATCH",
      );
    }
    const paused = await repository.pauseSchedule(pause);
    if (!samePauseTarget(paused, pause, configuration.expected)) {
      throw new PromotionJobScheduleCommandError(
        "PROMOTION_JOB_SCHEDULE_COMMAND_RESULT_INVALID",
      );
    }
    return result(configuration, paused, "changed");
  } catch (error) {
    if (error instanceof PromotionJobScheduleCommandError) throw error;
    if (
      error instanceof PromotionJobPersistenceError &&
      error.code === "PROMOTION_JOB_SCHEDULE_INVALID"
    ) throw new PromotionJobScheduleCommandError(
      "PROMOTION_JOB_SCHEDULE_COMMAND_CONFLICT",
    );
    throw error;
  }
}
