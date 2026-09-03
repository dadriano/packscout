import { Router } from "express";
import { requireLocalDatabaseTarget } from "../core/database-target.ts";
import type { StudioSupervisor } from "../core/studio-supervisor.ts";
import type { DatabaseMonitor } from "../database-monitor.ts";
import { openEventStream } from "../express/event-stream.ts";
import { recordPanelOutcome } from "../express/panel-access.ts";

/**
 * The database surface: one snapshot read, one live stream, and two guarded
 * row-browser actions.
 *
 * Everything here is mounted under `/api/database`, which is what places it
 * inside the panel's declared guard membership: reads require a loopback `Host`
 * (defeating DNS rebinding) and the two mutations additionally require the
 * panel's custom header and land in the audit trail.
 *
 * Permanent design invariant: no route accepts SQL, a command, or a path. The
 * only inputs are the HTTP method and the route itself; everything else is
 * resolved server-side from configuration the panel reads for itself.
 */

export const DATABASE_STATUS_EVENT = "database";

export interface DatabaseRouterOptions {
  monitor: DatabaseMonitor;
  supervisor: StudioSupervisor;
  /** Re-read on every attempt so no startup value can go stale. */
  env: Readonly<Record<string, string | undefined>>;
}

export function createDatabaseRouter({
  monitor,
  supervisor,
  env,
}: DatabaseRouterOptions): Router {
  const router = Router();

  router.get("/", (_request, response, next) => {
    monitor
      .refresh()
      .then((snapshot) => response.json(snapshot))
      .catch(next);
  });

  router.get("/stream", (request, response) => {
    const subscription: { release?: () => void } = {};
    const stream = openEventStream(request, response, () => subscription.release?.());
    subscription.release = monitor.subscribe((snapshot) => {
      stream.send(DATABASE_STATUS_EVENT, snapshot);
    });
    monitor
      .current()
      .then((snapshot) => stream.send(DATABASE_STATUS_EVENT, snapshot))
      .catch(() => stream.teardown());
  });

  /**
   * Start the row browser. The locality gate is evaluated here *and* inside the
   * supervisor, at the moment of the attempt: a client that believes the target
   * is local cannot make it so.
   */
  router.post("/row-browser", (_request, response, next) => {
    const decision = requireLocalDatabaseTarget(env);
    if (!decision.ok) {
      recordPanelOutcome(
        response,
        "rejected",
        "the row browser cannot run against a database that is not provably local",
      );
      response.status(decision.status).json({
        error: decision.message,
        code: decision.code,
      });
      return;
    }

    const result = supervisor.start();
    if (!result.started) {
      recordPanelOutcome(response, "failed", result.message ?? undefined);
      response.status(409).json({
        error: result.message ?? "The row browser could not be started.",
        code: "ops_panel_row_browser_unavailable",
      });
      return;
    }

    monitor
      .current()
      .then((snapshot) => response.status(202).json(snapshot))
      .catch(next);
  });

  router.delete("/row-browser", (_request, response, next) => {
    supervisor.stop();
    monitor
      .current()
      .then((snapshot) => response.json(snapshot))
      .catch(next);
  });

  return router;
}
