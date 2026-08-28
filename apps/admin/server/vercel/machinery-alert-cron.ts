import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

const MINIMUM_CRON_SECRET_BYTES = 32;

export interface MachineryAlertCycleGuard {
  run<T>(operation: () => Promise<T>): Promise<
    | Readonly<{ kind: "busy" }>
    | Readonly<{ kind: "executed"; value: T }>
  >;
}

export interface MachineryAlertCronDependencies {
  readSecret(): string;
  getGuard(): MachineryAlertCycleGuard;
  runCycle(): Promise<unknown>;
  reportFailure?(): void;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function isAuthorized(header: string | undefined, expectedSecret: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const presented = header.slice("Bearer ".length);
  return timingSafeEqual(digest(presented), digest(expectedSecret));
}

/**
 * Vercel calls this route with CRON_SECRET as a bearer credential. Admission
 * happens before either the database guard or the admin runtime is created.
 */
export function createMachineryAlertCronHandler(
  dependencies: MachineryAlertCronDependencies,
): RequestHandler {
  return async (request, response) => {
    response.setHeader("Cache-Control", "no-store");

    let expectedSecret: string;
    try {
      expectedSecret = dependencies.readSecret();
      if (Buffer.byteLength(expectedSecret, "utf8") < MINIMUM_CRON_SECRET_BYTES) {
        throw new Error("CRON_SECRET is not configured.");
      }
    } catch {
      dependencies.reportFailure?.();
      response.status(503).json({
        error: "The machinery alert scheduler is unavailable.",
        code: "MACHINERY_ALERT_SCHEDULER_UNAVAILABLE",
      });
      return;
    }

    if (!isAuthorized(request.get("authorization"), expectedSecret)) {
      response.status(401).json({
        error: "The machinery alert request was rejected.",
        code: "MACHINERY_ALERT_CRON_UNAUTHORIZED",
      });
      return;
    }

    try {
      const result = await dependencies
        .getGuard()
        .run(() => dependencies.runCycle());
      if (result.kind === "busy") {
        response.status(202).json({
          status: "skipped",
          code: "MACHINERY_ALERT_CYCLE_ALREADY_RUNNING",
        });
        return;
      }
      response.status(200).json({ status: "completed" });
    } catch {
      dependencies.reportFailure?.();
      response.status(503).json({
        error: "The machinery alert cycle could not be completed.",
        code: "MACHINERY_ALERT_CYCLE_FAILED",
      });
    }
  };
}
