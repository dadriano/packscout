import express, {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { requireLocalDatabaseTarget } from "../core/database-target.ts";
import { buildDatabaseOperationsSnapshot } from "../core/operation-status.ts";
import type { DatabaseOperationRunner } from "../core/operation-supervisor.ts";
import { openEventStream } from "../express/event-stream.ts";
import { recordPanelOutcome } from "../express/panel-access.ts";

/**
 * The operations surface: one snapshot read, one live stream, and one guarded
 * mutation per registered operation.
 *
 * Everything here is mounted under `/api/database`, which is what places it
 * inside the panel's declared guard membership: the reads require a loopback
 * `Host`, and the mutation additionally requires the panel's custom header and
 * lands in the audit trail whatever it answers.
 *
 * Permanent design invariant: the only thing a caller may name is one of the
 * registry's three identifiers, plus the acknowledgement text for the
 * destructive one. No command, path, script name, or SQL statement crosses this
 * boundary — the path segment is resolved against the registry and refused when
 * it is not a member, and the workspace script is read from that registry entry.
 */

export const OPERATIONS_EVENT = "operations";
export const OPERATION_OUTPUT_EVENT = "operation-output";

/** Acknowledgement text is a database name, not a payload. */
const BODY_LIMIT = "4kb";

export interface DatabaseOperationsRouterOptions {
  runner: DatabaseOperationRunner;
  /** Re-read on every attempt so no startup value can go stale. */
  env: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
}

export function createDatabaseOperationsRouter({
  runner,
  env,
  now = () => new Date(),
}: DatabaseOperationsRouterOptions): Router {
  const router = Router();

  function snapshot() {
    return buildDatabaseOperationsSnapshot({
      readAt: now().toISOString(),
      locality: requireLocalDatabaseTarget(env),
      running: runner.running(),
      last: runner.last(),
      output: runner.output(),
      outputLineLimit: runner.lineLimit,
      timeoutMs: runner.timeoutMs,
    });
  }

  router.get("/", (_request, response) => {
    response.json(snapshot());
  });

  router.get("/stream", (request, response) => {
    const subscription: { release?: () => void } = {};
    const stream = openEventStream(request, response, () => subscription.release?.());
    // A reattaching client is given the whole retained log first, so a panel
    // reopened mid-run shows the output that already happened rather than only
    // what arrives next.
    stream.send(OPERATIONS_EVENT, snapshot());
    subscription.release = runner.subscribe((event) => {
      if (event.type === "output") {
        stream.send(OPERATION_OUTPUT_EVENT, {
          runId: event.runId,
          lines: event.lines,
        });
        return;
      }
      stream.send(OPERATIONS_EVENT, snapshot());
    });
  });

  router.post(
    "/:operation",
    express.json({ limit: BODY_LIMIT }),
    (request: Request, response: Response, next: NextFunction) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      // Awaited because the supervisor does not spawn until the run's in-flight
      // marker is durable: answering earlier would tell the operator a run had
      // started that a crash could still lose without trace.
      runner
        .start({
          operation: request.params.operation,
          acknowledgement: body.acknowledgement,
          expectedDatabase: body.expectedDatabase,
        })
        .then((result) => {
          if (!result.ok) {
            recordPanelOutcome(response, "rejected", result.message);
            response.status(result.status).json({
              error: result.message,
              code: result.code,
            });
            return;
          }

          recordPanelOutcome(
            response,
            "succeeded",
            `started ${result.run.label.toLowerCase()} against "${result.run.database}" (run ${result.run.runId})`,
          );
          response.status(202).json(snapshot());
        })
        .catch(next);
    },
  );

  // A malformed or oversized body is a client mistake, and it answers in the
  // panel's own error shape rather than falling through to the generic handler.
  router.use(
    (error: unknown, _request: Request, response: Response, next: NextFunction) => {
      if (response.headersSent) {
        next(error);
        return;
      }
      const status =
        typeof error === "object" && error !== null && "status" in error
          ? Number((error as { status?: unknown }).status)
          : 0;
      if (status !== 400 && status !== 413) {
        next(error);
        return;
      }
      recordPanelOutcome(
        response,
        "rejected",
        "the request body was not a small JSON object",
      );
      response.status(400).json({
        error:
          "An operation request carries at most a small JSON object naming the acknowledgement; this body could not be read as one.",
        code: "ops_panel_operation_request_invalid",
      });
    },
  );

  return router;
}
