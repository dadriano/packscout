import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  toLogSource,
  type LogSource,
  type LogSourceChange,
  type LogSourceRegistry,
} from "./core/log-sources.ts";

/**
 * The filesystem half of source discovery: poll the per-service log directory
 * on a bounded interval and hand the listing to the pure registry.
 *
 * Polling — rather than a filesystem watcher — is deliberate: watchers miss
 * events across editors, rotation, and network volumes, and a bounded poll is
 * the behavior the panel can honestly promise.
 */

export interface LogSourcePoller {
  refresh(): Promise<LogSourceChange | null>;
  start(): void;
  stop(): void;
  isRunning(): boolean;
}

export interface LogSourcePollerOptions {
  directory: string;
  registry: LogSourceRegistry;
  intervalMs: number;
  onError?: (error: unknown) => void;
  readDirectory?: (directory: string) => Promise<string[]>;
  statFile?: (filePath: string) => Promise<{
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
    isFile(): boolean;
  }>;
}

export function createLogSourcePoller({
  directory,
  registry,
  intervalMs,
  onError,
  readDirectory = (target) => readdir(target),
  statFile = (filePath) => stat(filePath),
}: LogSourcePollerOptions): LogSourcePoller {
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight = false;

  async function listSources(): Promise<LogSource[]> {
    let fileNames: string[];
    try {
      fileNames = await readDirectory(directory);
    } catch {
      // A directory that does not exist yet simply has no sources.
      return [];
    }

    const sources: LogSource[] = [];
    for (const fileName of fileNames) {
      try {
        const details = await statFile(path.join(directory, fileName));
        if (!details.isFile()) continue;
        const source = toLogSource(fileName, {
          deviceId: details.dev,
          inode: details.ino,
          sizeBytes: details.size,
          modifiedAtMs: details.mtimeMs,
        });
        if (source) sources.push(source);
      } catch {
        // The file disappeared between listing and stat: the next poll settles it.
      }
    }
    return sources;
  }

  const poller: LogSourcePoller = {
    async refresh() {
      if (inFlight) return null;
      inFlight = true;
      try {
        return registry.refresh(await listSources());
      } catch (error) {
        onError?.(error);
        return null;
      } finally {
        inFlight = false;
      }
    },
    start() {
      if (timer) return;
      void poller.refresh();
      timer = setInterval(() => {
        void poller.refresh();
      }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = undefined;
    },
    isRunning: () => timer !== undefined,
  };

  return poller;
}
