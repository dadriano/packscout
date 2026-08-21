import { open, stat } from "node:fs/promises";
import path from "node:path";
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
import { clampWindowLines, type ByteRange } from "./core/log-window.ts";
import { logFileNameForService } from "./core/service-logs.ts";

/**
 * The filesystem half of history browsing.
 *
 * Like the tail reader beside it, a descriptor is opened for one positional
 * read and closed immediately: a panel that parks handles on rotated files is a
 * reason a developer cannot reclaim disk space.
 *
 * The generation guard is the load-bearing part. Offsets are only meaningful
 * inside one continuous run of bytes behind a name, so a request that names a
 * generation the file no longer has is *refused* rather than answered with
 * bytes from the new one. Mixing two generations in one pane would present
 * invented history as real, which is the one failure a log viewer must not
 * have; returning the reader to live with a marker is the honest alternative,
 * and the client does exactly that when it sees this refusal.
 */

export type LogHistoryDirection = HistoryDirection | "around";

export class LogGenerationChangedError extends Error {
  readonly code = "ops_panel_log_generation_changed";
  readonly service: string;
  readonly requestedGeneration: number;
  readonly currentGeneration: number;

  constructor(service: string, requested: number, current: number) {
    super(
      "This log started a new generation, so those byte offsets no longer describe it.",
    );
    this.name = "LogGenerationChangedError";
    this.service = service;
    this.requestedGeneration = requested;
    this.currentGeneration = current;
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

export interface RawLogFile {
  service: string;
  fileName: string;
  filePath: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface LogHistoryReaderOptions {
  directory: string;
  hub: LogStreamHub;
  now?: () => number;
  statFile?: (filePath: string) => Promise<{ size: number; mtimeMs: number }>;
  readRange?: (filePath: string, range: ByteRange) => Promise<Uint8Array>;
}

export interface LogHistoryReader {
  readPage(request: LogHistoryRequest): Promise<LogHistoryPage>;
  /** Path and size for a streamed download; the file itself is never read here. */
  describeRawFile(service: string): Promise<RawLogFile>;
}

async function readRangeFromFile(
  filePath: string,
  range: ByteRange,
): Promise<Uint8Array> {
  if (range.length <= 0) return new Uint8Array(0);
  const handle = await open(filePath, "r");
  try {
    const buffer = new Uint8Array(range.length);
    const { bytesRead } = await handle.read(buffer, 0, range.length, range.offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export function createLogHistoryReader({
  directory,
  hub,
  now = () => Date.now(),
  statFile = (filePath) => stat(filePath),
  readRange = readRangeFromFile,
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
      let fileSize: number;
      try {
        fileSize = (await statFile(filePath)).size;
      } catch {
        return absent(service, generation, direction);
      }

      const maxLines = clampWindowLines(request.lines, DEFAULT_HISTORY_LINES);
      const budgetBytes = clampHistoryBudget(request.budgetBytes);
      const readAtMs = now();
      const readAt = new Date(readAtMs).toISOString();

      // The live tail owns everything from its cursor onwards, so history stops
      // exactly where it begins: the two never overlap and never leave a hole.
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
        const bytes = await readRange(filePath, chunk);
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
        startCursor: direction === "backward" ? read.nextCursor : read.startOffset,
        endCursor: direction === "backward" ? read.endOffset : read.nextCursor,
        atStart: read.atStart,
        atEnd: read.atEnd,
        fragmented: read.fragmented,
        bytesRead: read.bytesRead,
        readAt,
        lines: read.lines,
      };
    },

    async describeRawFile(service) {
      const fileName = logFileNameForService(service);
      const filePath = filePathFor(service);
      const details = await statFile(filePath);
      return {
        service,
        fileName,
        filePath,
        sizeBytes: details.size,
        modifiedAt: new Date(details.mtimeMs).toISOString(),
      };
    },
  };
}
