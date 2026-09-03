import { Router, type Response } from "express";
import { z } from "zod";
import {
  WORKER_FLEET_PAGE_LIMIT,
  type ScheduleHealthView,
  type StalledRunView,
  type WorkerFleetEvaluation,
  type WorkerFleetSettingsResolution,
  type WorkerInstanceView,
} from "@packscout/contracts";
import type { AuthService } from "@packscout/services";
import type { SessionCookiePolicy } from "../auth/cookies.ts";
import {
  createRequireSession,
  getAuthenticatedActor,
} from "../auth/middleware.ts";

/**
 * Protected read surface for the worker fleet. Every response carries
 * conditions the server already evaluated — fleet silence, run stalls, schedule
 * health — so the browser renders a judgement rather than re-deriving one that
 * alerting also depends on.
 */

const instanceQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(WORKER_FLEET_PAGE_LIMIT)
      .default(25),
  })
  .strict();

const pageQuerySchema = instanceQuerySchema
  .extend({ cursor: z.string().trim().min(1).max(512).optional() })
  .strict();

export interface WorkerFleetInstancesPage {
  readonly instances: readonly WorkerInstanceView[];
  readonly hasMore: boolean;
  readonly fleet: WorkerFleetEvaluation;
  readonly settings: WorkerFleetSettingsResolution;
}

export interface StalledRunPage {
  readonly items: readonly StalledRunView[];
  readonly nextCursor: string | null;
  readonly staleAfterMs: number | null;
}

export interface ScheduleHealthPage {
  readonly items: readonly ScheduleHealthView[];
  readonly nextCursor: string | null;
  readonly overdueAfterMs: number | null;
}

export interface WorkerSettingsReport {
  readonly settings: WorkerFleetSettingsResolution;
  readonly observedAt: string;
}

export interface WorkerFleetRouterDependencies {
  readonly auth: Pick<AuthService, "resolveSession" | "requirePermission">;
  readonly reads: {
    listInstances(input: {
      organizationId: string;
      limit: number;
    }): Promise<WorkerFleetInstancesPage>;
    listStalledRuns(input: {
      organizationId: string;
      cursor?: string;
      limit: number;
    }): Promise<StalledRunPage>;
    listScheduleHealth(input: {
      organizationId: string;
      cursor?: string;
      limit: number;
    }): Promise<ScheduleHealthPage>;
    readSettings(input: {
      organizationId: string;
    }): Promise<WorkerSettingsReport>;
  };
  readonly cookiePolicy: SessionCookiePolicy;
}

const workerIdentityPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const outcomePattern = /^[a-z][a-z0-9_]{0,63}$/;

function bounded(value: string, maximum = 200): string {
  return value.slice(0, maximum);
}

/**
 * Worker identities are operator-facing but originate outside the admin, so a
 * value that does not match the published identity shape is dropped rather than
 * forwarded into the browser.
 */
function workerIdentity(value: string | null): string | null {
  if (value === null) return null;
  return workerIdentityPattern.test(value) ? value : null;
}

function identifier(value: string | null): string | null {
  if (value === null) return null;
  return uuidPattern.test(value) ? value : null;
}

function sanitizeInstance(instance: WorkerInstanceView): WorkerInstanceView {
  return {
    instanceId: workerIdentity(instance.instanceId) ?? "unidentified-instance",
    status: instance.status,
    state: instance.state,
    version: bounded(instance.version, 128),
    host: bounded(instance.host, 128),
    runtimeVersion: bounded(instance.runtimeVersion, 64),
    startedAt: instance.startedAt,
    upForMs: instance.upForMs,
    lastHeartbeatAt: instance.lastHeartbeatAt,
    heartbeatAgeMs: instance.heartbeatAgeMs,
    stoppedAt: instance.stoppedAt,
    activity: {
      kind: instance.activity.kind,
      scope: instance.activity.scope,
      // Cross-workspace work is named by kind only, so no foreign tenant's
      // provider or run identity ever reaches this operator's browser.
      providerId:
        instance.activity.scope === "workspace"
          ? identifier(instance.activity.providerId)
          : null,
      providerName:
        instance.activity.scope === "workspace" &&
        instance.activity.providerName !== null
          ? bounded(instance.activity.providerName, 128)
          : null,
      runId:
        instance.activity.scope === "workspace"
          ? identifier(instance.activity.runId)
          : null,
      startedAt: instance.activity.startedAt,
      ageMs: instance.activity.ageMs,
    },
    effectiveSettings: instance.effectiveSettings,
  };
}

function sanitizeStalledRun(run: StalledRunView): StalledRunView {
  return {
    runId: run.runId,
    providerId: run.providerId,
    providerName: bounded(run.providerName, 128),
    platformKey: bounded(run.platformKey, 128),
    trigger: run.trigger,
    startedAt: run.startedAt,
    lastHeartbeatAt: run.lastHeartbeatAt,
    stall: run.stall,
    leaseOwner: workerIdentity(run.leaseOwner),
    leaseOwnerPresent: run.leaseOwnerPresent,
    leaseExpiresAt: run.leaseExpiresAt,
    leaseExpired: run.leaseExpired,
  };
}

function sanitizeSchedule(schedule: ScheduleHealthView): ScheduleHealthView {
  const lastOutcome =
    schedule.lastOutcome !== null && outcomePattern.test(schedule.lastOutcome)
      ? schedule.lastOutcome
      : null;
  return {
    providerId: schedule.providerId,
    providerName: bounded(schedule.providerName, 128),
    platformKey: bounded(schedule.platformKey, 128),
    nextDueAt: schedule.nextDueAt,
    health: schedule.health,
    claimOwner: workerIdentity(schedule.claimOwner),
    claimOwnerPresent: schedule.claimOwnerPresent,
    claimExpiresAt: schedule.claimExpiresAt,
    lastClaimedAt: schedule.lastClaimedAt,
    lastOutcome,
    lastRunId: identifier(schedule.lastRunId),
  };
}

function invalid(response: Response, details: unknown): void {
  response.status(422).json({
    error: "Check the worker fleet request and try again.",
    code: "INVALID_WORKER_FLEET_REQUEST",
    details,
  });
}

function failure(response: Response, error: unknown): void {
  if (typeof error === "object" && error !== null && "code" in error) {
    if (error.code === "INVALID_OPERATION_CURSOR") {
      response.status(422).json({
        error: "The worker fleet page cursor is invalid.",
        code: "INVALID_OPERATION_CURSOR",
      });
      return;
    }
    if (error.code === "RATE_LIMITED") {
      response.status(429).json({
        error: "Too many operation requests. Try again later.",
        code: "RATE_LIMITED",
      });
      return;
    }
  }
  response.status(503).json({
    error: "Worker fleet status is temporarily unavailable.",
    code: "SERVICE_UNAVAILABLE",
  });
}

function nextCursor(value: string | null): string | null {
  return value === null ? null : bounded(value, 512);
}

export function createWorkerFleetRouter(
  dependencies: WorkerFleetRouterDependencies,
) {
  const router = Router();
  // Worker status is operational reading with no secrets and no mutation, so
  // it sits behind the same view-oriented pipeline permission both operator
  // roles already hold for runs, quarantine, and provider status.
  const read = createRequireSession(
    dependencies.auth,
    dependencies.cookiePolicy,
    { permission: "providers:view" },
  );

  router.get("/instances", read, async (request, response) => {
    const query = instanceQuerySchema.safeParse(request.query);
    if (!query.success) {
      return invalid(response, query.error.flatten().fieldErrors);
    }
    try {
      const session = getAuthenticatedActor(response);
      const result = await dependencies.reads.listInstances({
        organizationId: session.organizationId,
        limit: query.data.limit,
      });
      response.setHeader("Cache-Control", "no-store");
      response.status(200).json({
        instances: result.instances
          .slice(0, query.data.limit)
          .map(sanitizeInstance),
        hasMore: result.hasMore,
        fleet: result.fleet,
        settings: result.settings,
      });
    } catch (error) {
      failure(response, error);
    }
  });

  router.get("/stalled-runs", read, async (request, response) => {
    const query = pageQuerySchema.safeParse(request.query);
    if (!query.success) {
      return invalid(response, query.error.flatten().fieldErrors);
    }
    try {
      const session = getAuthenticatedActor(response);
      const result = await dependencies.reads.listStalledRuns({
        organizationId: session.organizationId,
        ...query.data,
      });
      response.setHeader("Cache-Control", "no-store");
      response.status(200).json({
        items: result.items.slice(0, query.data.limit).map(sanitizeStalledRun),
        nextCursor: nextCursor(result.nextCursor),
        staleAfterMs: result.staleAfterMs,
      });
    } catch (error) {
      failure(response, error);
    }
  });

  router.get("/schedules", read, async (request, response) => {
    const query = pageQuerySchema.safeParse(request.query);
    if (!query.success) {
      return invalid(response, query.error.flatten().fieldErrors);
    }
    try {
      const session = getAuthenticatedActor(response);
      const result = await dependencies.reads.listScheduleHealth({
        organizationId: session.organizationId,
        ...query.data,
      });
      response.setHeader("Cache-Control", "no-store");
      response.status(200).json({
        items: result.items.slice(0, query.data.limit).map(sanitizeSchedule),
        nextCursor: nextCursor(result.nextCursor),
        overdueAfterMs: result.overdueAfterMs,
      });
    } catch (error) {
      failure(response, error);
    }
  });

  router.get("/settings", read, async (_request, response) => {
    try {
      const session = getAuthenticatedActor(response);
      const report = await dependencies.reads.readSettings({
        organizationId: session.organizationId,
      });
      response.setHeader("Cache-Control", "no-store");
      response.status(200).json(report);
    } catch (error) {
      failure(response, error);
    }
  });

  return router;
}
