import { Router } from "express";
import type { LogStreamHub } from "../core/log-stream-hub.ts";
import { isSafeServiceName } from "../core/service-logs.ts";
import { clampWindowLines } from "../core/log-window.ts";
import { openEventStream } from "../express/event-stream.ts";
import type { LogTailReader } from "../log-tail-reader.ts";

/**
 * The live-log surface: one bounded initial-window read and one stream.
 *
 * Both mount under `/api/logs`, which is what places them inside the panel's
 * declared sensitive-read membership — the guard is not repeated here.
 *
 * The stream carries every service. Which services an operator is *looking* at
 * is a view decision, so it is made in the browser; the connection is never
 * torn down to change it.
 */

export const LOG_STREAM_EVENT = "logs";

export interface LogsRouterOptions {
  hub: LogStreamHub;
  reader: LogTailReader;
}

export function createLogsRouter({ hub, reader }: LogsRouterOptions): Router {
  const router = Router();

  router.get("/window", (request, response, next) => {
    const requested = clampWindowLines(request.query.lines);
    const service = request.query.service;

    if (service !== undefined) {
      if (typeof service !== "string" || !isSafeServiceName(service)) {
        response.status(400).json({
          error: "That is not a PackScout service name.",
          code: "ops_panel_unknown_service",
        });
        return;
      }
      reader
        .readWindow(service, requested)
        .then((window) => {
          response.json({
            readAt: new Date().toISOString(),
            requestedLines: requested,
            windows: [window],
          });
        })
        .catch(next);
      return;
    }

    reader
      .readWindows(requested)
      .then((windows) => {
        response.json({
          readAt: new Date().toISOString(),
          requestedLines: requested,
          windows,
        });
      })
      .catch(next);
  });

  router.get("/stream", (request, response) => {
    const subscription: { release?: () => void } = {};
    const stream = openEventStream(request, response, () =>
      subscription.release?.(),
    );
    subscription.release = hub.subscribe((batch) => {
      stream.send(LOG_STREAM_EVENT, {
        emittedAt: new Date().toISOString(),
        lines: batch.lines,
        markers: batch.markers,
      });
    });
    // An immediate empty frame tells the client the stream is live before any
    // service has written anything, so "connecting" resolves promptly.
    stream.send(LOG_STREAM_EVENT, {
      emittedAt: new Date().toISOString(),
      lines: [],
      markers: [],
    });
  });

  return router;
}
