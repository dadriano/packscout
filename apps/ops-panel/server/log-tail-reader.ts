import path from "node:path";
import { logFileNameForService } from "./core/service-logs.ts";
import type { LogSourceRegistry } from "./core/log-sources.ts";
import type { LogStreamHub } from "./core/log-stream-hub.ts";
import type { LogTailer } from "./core/log-tail.ts";
import type { LogLineRecord } from "./core/log-records.ts";
import {
  alignWindowStart,
  clampWindowLines,
  planBackwardScan,
  DEFAULT_WINDOW_SCAN_BYTES,
} from "./core/log-window.ts";
import { createLogLineSplitter } from "./core/log-line-splitter.ts";
import { openLogFile, type OpenLogFile } from "./log-file-handle.ts";

/**
 * The filesystem half of tailing.
 *
 * Every pass opens the file exactly once and answers from that descriptor: the
 * identity the tail is told about, the size its plan is derived from, and the
 * bytes it ingests all come from the same open file. Statting a path and then
 * re-opening it to read leaves a window in which a rotation can substitute a
 * different file, whose bytes would then be published under the old
 * generation's offsets — duplicated and misordered output that looks real.
 *
 * The descriptor is closed at the end of the pass. A tail that parks an open
 * handle on every service keeps rotated files alive on disk and makes the panel
 * a reason a developer cannot reclaim space.
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
  /** Injected so a test can rotate a file between the open and the read. */
  openFile?: OpenLogFile;
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

export function createLogTailReader({
  directory,
  registry,
  hub,
  intervalMs,
  onError,
  now = () => Date.now(),
  openFile = openLogFile,
}: LogTailReaderOptions): LogTailReader {
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight = false;

  function filePathFor(service: string): string {
    return path.join(directory, logFileNameForService(service));
  }

  /** Tell the tail a file has gone, and publish whatever that produced. */
  function reportAbsent(tailer: LogTailer): void {
    const step = tailer.observe({ present: false }, now());
    hub.publish({ lines: step.lines, markers: step.markers });
  }

  async function advance(service: string): Promise<void> {
    const tailer = hub.tailer(service);
    const file = await openFile(filePathFor(service));
    if (file === null) {
      reportAbsent(tailer);
      return;
    }

    try {
      // Identity, size and bytes all come from this one descriptor, so a
      // rotation cannot slip a different file in between the plan and the read.
      const step = tailer.observe(
        { present: true, fileId: file.identity, sizeBytes: file.sizeBytes },
        now(),
      );
      hub.publish({ lines: step.lines, markers: step.markers });

      if (step.align) {
        tailer.adoptAlignment(step.align, await file.read(step.align));
        return;
      }

      if (step.read) {
        hub.publish(tailer.ingest(step.read, await file.read(step.read), now()));
      }

      hub.publish(tailer.tick(now()));
    } finally {
      await file.close();
    }
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
      const file = await openFile(filePathFor(service));
      if (file === null) {
        reportAbsent(tailer);
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

      try {
        // The window is read through the tail rather than beside it: the same
        // observation the ticker would have made, from the same descriptor, so
        // the generation these lines carry is the generation the live stream
        // will carry too.
        const step = tailer.observe(
          { present: true, fileId: file.identity, sizeBytes: file.sizeBytes },
          now(),
        );
        hub.publish({ lines: step.lines, markers: step.markers });

        const generation = tailer.generation();
        // The window ends where the live tail begins, so the two never overlap
        // by accident and never leave a hole between them. Before a viewer
        // attaches there is no cursor, so end-of-file is the honest boundary.
        const endOffset = tailer.cursor() ?? file.sizeBytes;
        const scan = planBackwardScan(endOffset, DEFAULT_WINDOW_SCAN_BYTES);
        const bytes = await file.read(scan);
        const alignment = alignWindowStart(bytes, scan.offset, lineBudget);

        const splitter = createLogLineSplitter({
          service,
          generation,
          offset: alignment.offset,
        });
        const sliceStart = alignment.offset - scan.offset;
        const readAt = now();
        const lines = splitter
          .append(bytes.subarray(Math.max(0, sliceStart)), readAt)
          .map((line) => ({ ...line, backfilled: true }));
        const windowEnd = splitter.pendingOffset();

        // The handoff. A tail with no cursor yet would otherwise align itself
        // against end-of-file on its next tick, and anything written between
        // this read and that tick would be neither in the window nor in the
        // stream. Planting the cursor at this window's own boundary — from the
        // bytes this window was built from — leaves no such hole. It is ignored
        // when the tail is already streaming.
        tailer.adoptCursor(windowEnd);

        return {
          service,
          generation,
          present: true,
          complete: alignment.complete,
          startOffset: alignment.offset,
          endOffset: windowEnd,
          lines,
        };
      } finally {
        await file.close();
      }
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
