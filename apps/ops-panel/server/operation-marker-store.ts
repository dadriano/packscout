import { mkdir, rename, rm, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  OperationMarker,
  OperationMarkerStore,
} from "./core/operation-supervisor.ts";

export const OPERATION_MARKER_FILE_NAME = "operation-run.json";

/**
 * The durable marker that survives the panel.
 *
 * It holds at most one record — the operation currently in flight — and is
 * written before the child starts and removed the moment the run settles. If the
 * panel is killed in between, the file is still there when it comes back, which
 * is the whole mechanism by which an interrupted run is reported as *unknown*
 * rather than quietly forgotten.
 *
 * Written atomically (temp file then rename) with owner-only permissions, the
 * same way the audit trail is: a half-written marker would be indistinguishable
 * from a corrupted one, and the panel would rather report nothing than report a
 * run it invented.
 */
export function createFileOperationMarkerStore(
  filePath: string,
): OperationMarkerStore {
  const directory = path.dirname(filePath);

  return {
    async load() {
      try {
        return JSON.parse(await readFile(filePath, "utf8")) as unknown;
      } catch {
        // Missing or corrupted: there is nothing trustworthy to report, and a
        // panel that cannot read its marker must still start.
        return null;
      }
    },
    async save(marker: OperationMarker | null) {
      if (marker === null) {
        await rm(filePath, { force: true });
        return;
      }
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporaryPath = `${filePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(marker, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, filePath);
    },
  };
}
