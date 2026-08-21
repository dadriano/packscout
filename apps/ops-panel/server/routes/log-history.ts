import { createReadStream } from "node:fs";
import { Router } from "express";
import { recordPanelOutcome } from "../express/panel-access.ts";
import { isSafeServiceName } from "../core/service-logs.ts";
import {
  LogGenerationChangedError,
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
 * developer's disk for their memory.
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
        // would present invented history as real.
        response.status(409).json({
          error: error.message,
          code: error.code,
          service: error.service,
          generation: error.currentGeneration,
          requestedGeneration: error.requestedGeneration,
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
        // The file as it was when the download began: a length taken now stays
        // true even if the service keeps writing while the bytes are in flight.
        response.setHeader("content-type", "text/plain; charset=utf-8");
        response.setHeader("content-length", String(file.sizeBytes));
        response.setHeader("x-content-type-options", "nosniff");
        response.setHeader("cache-control", "no-store");
        response.setHeader(
          "content-disposition",
          `attachment; filename="${file.fileName}"`,
        );

        if (file.sizeBytes <= 0) {
          recordPanelOutcome(response, "succeeded", `${file.fileName} is empty`);
          response.end();
          return;
        }

        const source = createReadStream(file.filePath, {
          start: 0,
          end: file.sizeBytes - 1,
        });
        source.once("end", () => {
          recordPanelOutcome(
            response,
            "succeeded",
            `streamed ${file.sizeBytes} bytes of ${file.fileName}`,
          );
        });
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
      .catch(() => {
        response.status(404).json({
          error: "No log file is being written for that service.",
          code: "ops_panel_log_file_missing",
        });
      });
  });

  return router;
}
