import { Router } from "express";
import { recordPanelOutcome } from "../express/panel-access.ts";
import { isSafeServiceName } from "../core/service-logs.ts";
import {
  LogGenerationChangedError,
  RawLogUnidentifiedError,
  type LogHistoryDirection,
  type LogHistoryReader,
} from "../log-history-reader.ts";

/**
 * Reading the past: bounded pages, and one streamed file.
 *
 * Both mount under `/api/logs`, which is what puts them inside the panel's
 * declared sensitive-read membership. `/api/logs/download` is additionally
 * declared privileged *and* audited even though it is a read, because handing
 * over a whole log file is the largest disclosure this panel can make; the
 * guard is expressed once, as data, in `core/access.ts`.
 *
 * The download is streamed rather than read: a log file is exactly the kind of
 * thing that is occasionally a gigabyte, and buffering it would trade a
 * developer's disk for their memory. It streams from the descriptor its
 * `content-length` was measured on, not from the path — re-opening a name
 * between measuring it and reading it is precisely how a rotation gets to serve
 * the replacement file's bytes under the original file's length.
 */

const DIRECTIONS: readonly LogHistoryDirection[] = ["backward", "forward", "around"];

export interface LogHistoryRouterOptions {
  reader: LogHistoryReader;
}

function readOptionalOffset(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return undefined;
  return parsed;
}

export function createLogHistoryRouter({ reader }: LogHistoryRouterOptions): Router {
  const router = Router();

  router.get("/history", (request, response, next) => {
    const service = request.query.service;
    if (typeof service !== "string" || !isSafeServiceName(service)) {
      response.status(400).json({
        error: "That is not a PackScout service name.",
        code: "ops_panel_unknown_service",
      });
      return;
    }

    const requestedDirection = request.query.direction;
    const direction = DIRECTIONS.includes(requestedDirection as LogHistoryDirection)
      ? (requestedDirection as LogHistoryDirection)
      : "backward";

    const cursor = readOptionalOffset(request.query.cursor);
    if (direction === "around" && cursor === undefined) {
      response.status(400).json({
        error: "Reading context around a line needs the byte offset of that line.",
        code: "ops_panel_missing_cursor",
      });
      return;
    }

    reader
      .readPage({
        service,
        direction,
        cursor: cursor ?? null,
        lines: Number(request.query.lines),
        budgetBytes: Number(request.query.budget),
        generation: readOptionalOffset(request.query.generation) ?? null,
      })
      .then((page) => response.json(page))
      .catch((error: unknown) => {
        if (!(error instanceof LogGenerationChangedError)) {
          next(error);
          return;
        }
        // Refusing is the honest answer: these offsets describe bytes that are
        // no longer behind this name, and answering with the new file's bytes
        // would present invented history as real. `reason` says which check
        // caught it — the caller's generation, or the file's own identity.
        response.status(409).json({
          error: error.message,
          code: error.code,
          service: error.service,
          generation: error.currentGeneration,
          requestedGeneration: error.requestedGeneration,
          reason: error.reason,
        });
      });
  });

  router.get("/download", (request, response, next) => {
    const service = request.query.service;
    if (typeof service !== "string" || !isSafeServiceName(service)) {
      response.status(400).json({
        error: "That is not a PackScout service name.",
        code: "ops_panel_unknown_service",
      });
      return;
    }

    reader
      .describeRawFile(service)
      .then((file) => {
        // `close()` is idempotent, so every ending below can reach for it
        // without the endings having to know about each other.
        const release = (): void => {
          void file.close().catch(() => undefined);
        };

        // The client may already be gone: opening the file took a turn, and a
        // request abandoned during it would otherwise leave the descriptor with
        // nothing left to close it.
        if (response.writableEnded || response.destroyed) {
          release();
          return;
        }

        // The file as it was when the download began: a length taken now stays
        // true even if the service keeps writing while the bytes are in flight,
        // and the stream below reads the descriptor that length came from.
        response.setHeader("content-type", "text/plain; charset=utf-8");
        response.setHeader("content-length", String(file.sizeBytes));
        response.setHeader("x-content-type-options", "nosniff");
        response.setHeader("cache-control", "no-store");
        response.setHeader(
          "content-disposition",
          `attachment; filename="${file.fileName}"`,
        );

        if (file.sizeBytes <= 0) {
          release();
          recordPanelOutcome(response, "succeeded", `${file.fileName} is empty`);
          response.end();
          return;
        }

        const source = file.open();
        source.once("end", () => {
          recordPanelOutcome(
            response,
            "succeeded",
            `streamed ${file.sizeBytes} bytes of ${file.fileName}`,
          );
        });
        // `close` is the one event every ending shares — a finished stream, an
        // abandoned one, and a failed one all arrive here — so the descriptor
        // is released from exactly one place, after any read still in flight
        // has settled.
        source.once("close", release);
        source.once("error", (cause: unknown) => {
          source.destroy();
          if (response.headersSent) {
            response.destroy();
            return;
          }
          next(cause);
        });
        response.once("close", () => source.destroy());
        source.pipe(response);
      })
      .catch((error: unknown) => {
        if (error instanceof RawLogUnidentifiedError) {
          response.status(409).json({
            error: error.message,
            code: error.code,
            service: error.service,
          });
          return;
        }
        response.status(404).json({
          error: "No log file is being written for that service.",
          code: "ops_panel_log_file_missing",
        });
      });
  });

  return router;
}
