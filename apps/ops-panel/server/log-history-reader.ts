import path from "node:path";
import type { Readable } from "node:stream";
import {
  clampHistoryBudget,
  DEFAULT_HISTORY_LINES,
  planContextHalves,
  planHistoryChunk,
  readBackwardPage,
  readForwardPage,
  type HistoryDirection,
  type HistoryPage,
} from "./core/log-history.ts";
import type { LogLineRecord } from "./core/log-records.ts";
import type { LogStreamHub } from "./core/log-stream-hub.ts";
import { clampWindowLines } from "./core/log-window.ts";
import { logFileNameForService } from "./core/service-logs.ts";
import {
  isFileIdentity,
  openLogFile,
  streamLogFile,
  type OpenLogFile,
} from "./log-file-handle.ts";

/**
 * The filesystem half of history browsing.
 *
 * Like the tail reader beside it, one descriptor is opened per request and
 * closed immediately: a panel that parks handles on rotated files is a reason a
 * developer cannot reclaim disk space. One descriptor per *request*, not per
 * read — a context page reads above and below the same point, and two
 * independent opens could straddle a rotation and splice two files into one
 * pane.
 *
 * The generation guard is the load-bearing part, and it is anchored to the
 * file's identity rather than to a counter. Offsets are only meaningful inside
 * one continuous run of bytes behind a name, and the tail's counter only
 * advances when its poll notices a rotation — so during the window between a
 * rotation and the next tick, the counter still matches while the path already
 * resolves to a different file. Comparing the opened descriptor's `dev:ino`
 * against the identity the tail recorded for that generation closes that
 * window. Both checks refuse rather than answer: mixing two generations in one
 * pane would present invented history as real, which is the one failure a log
 * viewer must not have. Returning the reader to live with a marker is the
 * honest alternative, and the client does exactly that when it sees a refusal.
 */

export type LogHistoryDirection = HistoryDirection | "around";

/** Which check refused: the caller's counter, or the file behind the name. */
export type GenerationChangeReason = "generation" | "identity";

export class LogGenerationChangedError extends Error {
  readonly code = "ops_panel_log_generation_changed";
  readonly service: string;
  /** Null when the caller named no generation and identity refused it. */
  readonly requestedGeneration: number | null;
  readonly currentGeneration: number;
  readonly reason: GenerationChangeReason;

  constructor(
    service: string,
    requested: number | null,
    current: number,
    reason: GenerationChangeReason = "generation",
  ) {
    super(
      "This log started a new generation, so those byte offsets no longer describe it.",
    );
    this.name = "LogGenerationChangedError";
    this.service = service;
    this.requestedGeneration = requested;
    this.currentGeneration = current;
    this.reason = reason;
  }
}

export interface LogHistoryRequest {
  service: string;
  direction: LogHistoryDirection;
  /**
   * Backward: read up to here. Forward: read from here. Null means "the far
   * edge": the tail cursor going backwards, the first byte going forwards.
   */
  cursor: number | null;
  lines?: number;
  budgetBytes?: number;
  /** The generation the caller believes it is reading, if it knows one. */
  generation?: number | null;
}

export interface LogHistoryPage {
  service: string;
  generation: number;
  present: boolean;
  fileSize: number;
  direction: LogHistoryDirection;
  /** Where an older page would end. */
  startCursor: number;
  /** Where a newer page would begin. */
  endCursor: number;
  atStart: boolean;
  atEnd: boolean;
  /** True when a line larger than the budget came back as bounded fragments. */
  fragmented: boolean;
  bytesRead: number;
  readAt: string;
  lines: LogLineRecord[];
}

/**
 * A raw file the panel opened but could not identify. Serving it anyway would
 * mean promising a length taken from one thing and bytes taken from another.
 */
export class RawLogUnidentifiedError extends Error {
  readonly code = "ops_panel_log_file_unidentified";
  readonly service: string;

  constructor(service: string) {
    super(
      "That log file could not be identified on disk, so its bytes cannot be vouched for.",
    );
    this.name = "RawLogUnidentifiedError";
    this.service = service;
  }
}

/**
 * An open raw log file: the descriptor, the length taken from it, and a stream
 * that reads that same descriptor. There is deliberately no path here — a
 * pathname is what a rotation gets to redirect between the measurement and the
 * transfer, so the caller is never handed one to re-open.
 */
export interface RawLogFile {
  service: string;
  fileName: string;
  /** `dev:ino` of the descriptor these bytes come from. */
  identity: string;
  sizeBytes: number;
  modifiedAt: string;
  /** A stream over the measured descriptor. Never re-opens the name. */
  open(): Readable;
  /** Releases the descriptor. Idempotent, so every exit path may call it. */
  close(): Promise<void>;
}

export interface LogHistoryReaderOptions {
  directory: string;
  hub: LogStreamHub;
  now?: () => number;
  /** Injected so a test can rotate a file between two reads of one request. */
  openFile?: OpenLogFile;
}

export interface LogHistoryReader {
  readPage(request: LogHistoryRequest): Promise<LogHistoryPage>;
  /**
   * Opens the raw file and measures it. No bytes are read here — the caller
   * streams them from the returned descriptor and closes it when done.
   */
  describeRawFile(service: string): Promise<RawLogFile>;
}

export function createLogHistoryReader({
  directory,
  hub,
  now = () => Date.now(),
  openFile = openLogFile,
}: LogHistoryReaderOptions): LogHistoryReader {
  function filePathFor(service: string): string {
    return path.join(directory, logFileNameForService(service));
  }

  function absent(
    service: string,
    generation: number,
    direction: LogHistoryDirection,
  ): LogHistoryPage {
    return {
      service,
      generation,
      present: false,
      fileSize: 0,
      direction,
      startCursor: 0,
      endCursor: 0,
      atStart: true,
      atEnd: true,
      fragmented: false,
      bytesRead: 0,
      readAt: new Date(now()).toISOString(),
      lines: [],
    };
  }

  return {
    async readPage(request) {
      const { service, direction } = request;
      const tailer = hub.tailer(service);
      const generation = tailer.generation();
      if (
        request.generation !== undefined &&
        request.generation !== null &&
        request.generation !== generation
      ) {
        throw new LogGenerationChangedError(service, request.generation, generation);
      }

      const filePath = filePathFor(service);
      const file = await openFile(filePath);
      if (file === null) return absent(service, generation, direction);

      try {
        // The counter above says the tail has not *noticed* a rotation. This
        // says the file behind the name is still the one that generation was
        // assigned to — which is a different question during the poll window,
        // and the only one the descriptor can answer.
        const known = tailer.fileId();
        if (known !== null && known !== file.identity) {
          throw new LogGenerationChangedError(
            service,
            request.generation ?? null,
            generation,
            "identity",
          );
        }

        // Size from the descriptor, not from a second `stat`: every offset in
        // this page is relative to the file that is actually open.
        const fileSize = file.sizeBytes;
        const maxLines = clampWindowLines(request.lines, DEFAULT_HISTORY_LINES);
        const budgetBytes = clampHistoryBudget(request.budgetBytes);
        const readAtMs = now();
        const readAt = new Date(readAtMs).toISOString();

        // The live tail owns everything from its cursor onwards, so history
        // stops exactly where it begins: the two never overlap and never leave
        // a hole.
        const tailCursor = tailer.cursor() ?? fileSize;

        const page = async (
          pageDirection: HistoryDirection,
          cursor: number,
          lines: number,
        ): Promise<HistoryPage> => {
          const chunk = planHistoryChunk({
            direction: pageDirection,
            cursor,
            fileSize,
            budgetBytes,
          });
          const bytes = await file.read(chunk);
          const input = {
            service,
            generation,
            chunk,
            bytes,
            fileSize,
            maxLines: lines,
            readAtMs,
          };
          return pageDirection === "backward"
            ? readBackwardPage(input)
            : readForwardPage(input);
        };

        if (direction === "around") {
          const at = Math.max(0, Math.min(request.cursor ?? 0, fileSize));
          const halves = planContextHalves(maxLines);
          // Both halves are read from the one descriptor, so the context above
          // a match and the context below it cannot come from different files.
          const before = await page("backward", at, halves.before);
          const after = await page("forward", at, halves.after);
          return {
            service,
            generation,
            present: true,
            fileSize,
            direction,
            startCursor: before.nextCursor,
            endCursor: after.nextCursor,
            atStart: before.atStart,
            atEnd: after.atEnd,
            fragmented: before.fragmented || after.fragmented,
            bytesRead: before.bytesRead + after.bytesRead,
            readAt,
            lines: [...before.lines, ...after.lines],
          };
        }

        const cursor =
          request.cursor ?? (direction === "backward" ? tailCursor : 0);
        const read = await page(direction, cursor, maxLines);
        return {
          service,
          generation,
          present: true,
          fileSize,
          direction,
          startCursor:
            direction === "backward" ? read.nextCursor : read.startOffset,
          endCursor: direction === "backward" ? read.endOffset : read.nextCursor,
          atStart: read.atStart,
          atEnd: read.atEnd,
          fragmented: read.fragmented,
          bytesRead: read.bytesRead,
          readAt,
          lines: read.lines,
        };
      } finally {
        await file.close();
      }
    },

    async describeRawFile(service) {
      const fileName = logFileNameForService(service);
      const file = await openFile(filePathFor(service));
      if (file === null) {
        throw new Error(`No log file is being written for ${service}.`);
      }

      // The one close, guarded rather than scattered: the download has several
      // endings — finished, abandoned, failed — and each of them reaches for
      // this, so it has to be safe to reach for more than once.
      let released = false;
      const close = async (): Promise<void> => {
        if (released) return;
        released = true;
        await file.close();
      };

      try {
        // The descriptor has to be able to say which file it is. Without that,
        // the length below and the bytes that follow it are two claims about a
        // name rather than one statement about a file, and refusing beats
        // serving a download nobody can vouch for.
        if (!isFileIdentity(file.identity)) {
          throw new RawLogUnidentifiedError(service);
        }
        return {
          service,
          fileName,
          identity: file.identity,
          // Length and bytes both come from this descriptor, so a rotation
          // between the two cannot serve the replacement file under the
          // original file's `content-length`.
          sizeBytes: file.sizeBytes,
          modifiedAt: new Date(file.modifiedAtMs).toISOString(),
          open: () =>
            streamLogFile(file, { offset: 0, length: file.sizeBytes }),
          close,
        };
      } catch (error) {
        await close();
        throw error;
      }
    },
  };
}
