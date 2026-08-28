import { Router } from "express";
import type { LogSourceRegistry } from "../core/log-sources.ts";
import { openEventStream } from "../express/event-stream.ts";

/**
 * Source discovery, exposed twice: a snapshot read and a live change stream.
 * Both are sensitive reads (they live under `/api/logs`), so the access
 * middleware has already required a loopback `Host`.
 *
 * admin-tools/011 (tailing) and admin-tools/012 (history) consume this payload:
 * service name, file identity, size, and last-write time.
 */

export interface LogSourcesRouterOptions {
  registry: LogSourceRegistry;
  logDirectory: string;
  pollIntervalMs: number;
}

export const LOG_SOURCES_EVENT = "sources";

export function createLogSourcesRouter({
  registry,
  logDirectory,
  pollIntervalMs,
}: LogSourcesRouterOptions): Router {
  const router = Router();

  function snapshotPayload() {
    return {
      logDirectory,
      pollIntervalMs,
      revision: registry.revision(),
      sources: registry.snapshot(),
      added: [],
      removed: [],
      changed: [],
    };
  }

  router.get("/", (_request, response) => {
    response.json(snapshotPayload());
  });

  router.get("/stream", (request, response) => {
    // Held in a box so teardown can release a subscription created after the
    // stream opens, without a mutable binding.
    const subscription: { release?: () => void } = {};
    const stream = openEventStream(request, response, () =>
      subscription.release?.(),
    );
    subscription.release = registry.subscribe((change) => {
      stream.send(LOG_SOURCES_EVENT, {
        logDirectory,
        pollIntervalMs,
        revision: change.revision,
        sources: change.sources,
        added: change.added,
        removed: change.removed,
        changed: change.changed,
      });
    });
    stream.send(LOG_SOURCES_EVENT, snapshotPayload());
  });

  return router;
}
