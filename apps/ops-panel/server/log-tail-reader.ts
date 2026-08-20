import { open, stat } from "node:fs/promises";
import path from "node:path";
import { logFileNameForService } from "./core/service-logs.ts";
import type { LogSourceRegistry } from "./core/log-sources.ts";
import type { LogStreamHub } from "./core/log-stream-hub.ts";
import type { LogFileObservation } from "./core/log-tail.ts";
import type { LogLineRecord } from "./core/log-records.ts";
import {
  alignWindowStart,
  clampWindowLines,
  planBackwardScan,
  DEFAULT_WINDOW_SCAN_BYTES,
  type ByteRange,
} from "./core/log-window.ts";
import { createLogLineSplitter } from "./core/log-line-splitter.ts";

/**
 * The filesystem half of tailing.
 *
 * File handles are opened for the duration of one positional read and closed
 * immediately: a tail that parks an open descriptor on every service keeps
 * rotated files alive on disk and makes the panel a reason a developer cannot
 * reclaim space. Statting is cheap and already happens for source discovery, so
 * the expensive resource is only held when there are actually bytes to move.
 *
 * The ticker runs regardless of viewers, because identity has to keep being
 * tracked; it just gets no read plan back while the fleet is passive.
 */

export interface LogTailReaderOptions {
  directory: string;
  registry: LogSourceRegistry;
  hub: LogStreamHub;
  intervalMs: number;
  onError?: (error: unknown) => void;
  now?: () => number;
  statFile?: (filePath: string) => Promise<{
    dev: number;
    ino: number;
    size: number;
  }>;
  readRange?: (filePath: string, range: ByteRange) => Promise<Uint8Array>;
}

export interface LogWindow {
  service: string;
  generation: number;
  present: boolean;
  /** False when the window is bounded by the backward scan, not the file start. */
  complete: boolean;
  startOffset: number;
  /** Offset the live tail continues from; the window never crosses it. */
  endOffset: number;
  lines: LogLineRecord[];
}

export interface LogTailReader {
  tick(): Promise<void>;
  start(): void;
  stop(): void;
  isRunning(): boolean;
  readWindow(service: string, requestedLines: number): Promise<LogWindow>;
  readWindows(requestedLines: number): Promise<LogWindow[]>;
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

export function createLogTailReader({
  directory,
  registry,
  hub,
  intervalMs,
  onError,
  now = () => Date.now(),
  statFile = (filePath) => stat(filePath),
  readRange = readRangeFromFile,
}: LogTailReaderOptions): LogTailReader {
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight = false;

  function filePathFor(service: string): string {
    return path.join(directory, logFileNameForService(service));
  }

  async function observeFile(service: string): Promise<LogFileObservation> {
    try {
      const details = await statFile(filePathFor(service));
      return {
        present: true,
        fileId: `${details.dev}:${details.ino}`,
        sizeBytes: details.size,
      };
    } catch {
      return { present: false };
    }
  }

  async function advance(service: string): Promise<void> {
    const tailer = hub.tailer(service);
    const filePath = filePathFor(service);
    const observation = await observeFile(service);
    const step = tailer.observe(observation, now());
    hub.publish({ lines: step.lines, markers: step.markers });

    if (step.align) {
      const bytes = await readRange(filePath, step.align);
      tailer.adoptAlignment(step.align, bytes);
      return;
    }

    if (step.read) {
      const bytes = await readRange(filePath, step.read);
      hub.publish(tailer.ingest(step.read, bytes, now()));
    }

    hub.publish(tailer.tick(now()));
  }

  const reader: LogTailReader = {
    async tick() {
      if (inFlight) return;
      inFlight = true;
      try {
        const services = new Set<string>([
          ...registry.snapshot().map((source) => source.service),
          ...hub.services(),
        ]);
        for (const service of [...services].sort()) {
          try {
            await advance(service);
          } catch (error) {
            onError?.(error);
          }
        }
      } finally {
        inFlight = false;
      }
    },

    start() {
      if (timer) return;
      void reader.tick();
      timer = setInterval(() => {
        void reader.tick();
      }, intervalMs);
      timer.unref?.();
    },

    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = undefined;
    },

    isRunning: () => timer !== undefined,

    async readWindow(service, requestedLines) {
      const lineBudget = clampWindowLines(requestedLines);
      const tailer = hub.tailer(service);
      const observation = await observeFile(service);
      if (!observation.present) {
        return {
          service,
          generation: tailer.generation(),
          present: false,
          complete: true,
          startOffset: 0,
          endOffset: 0,
          lines: [],
        };
      }

      // The window ends where the live tail begins, so the two never overlap by
      // accident and never leave a hole between them. Before a viewer attaches
      // there is no cursor, so end-of-file is the honest boundary.
      const endOffset = tailer.cursor() ?? observation.sizeBytes;
      const scan = planBackwardScan(endOffset, DEFAULT_WINDOW_SCAN_BYTES);
      const bytes = await readRange(filePathFor(service), scan);
      const alignment = alignWindowStart(bytes, scan.offset, lineBudget);

      const splitter = createLogLineSplitter({
        service,
        generation: tailer.generation(),
        offset: alignment.offset,
      });
      const sliceStart = alignment.offset - scan.offset;
      const readAt = now();
      const lines = splitter
        .append(bytes.subarray(Math.max(0, sliceStart)), readAt)
        .map((line) => ({ ...line, backfilled: true }));

      return {
        service,
        generation: tailer.generation(),
        present: true,
        complete: alignment.complete,
        startOffset: alignment.offset,
        endOffset: splitter.pendingOffset(),
        lines,
      };
    },

    async readWindows(requestedLines) {
      const services = new Set<string>([
        ...registry.snapshot().map((source) => source.service),
        ...hub.services(),
      ]);
      const windows: LogWindow[] = [];
      for (const service of [...services].sort()) {
        try {
          windows.push(await reader.readWindow(service, requestedLines));
        } catch (error) {
          onError?.(error);
        }
      }
      return windows;
    },
  };

  return reader;
}
