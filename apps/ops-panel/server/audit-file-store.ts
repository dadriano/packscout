import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuditEntry, AuditTrailStore } from "./core/audit-trail.ts";

export const AUDIT_FILE_NAME = "audit.json";

/**
 * File persistence for the audit trail. The trail is already bounded in memory,
 * so the whole list is rewritten atomically (temp file then rename) instead of
 * appending forever. Owner-only permissions: the trail records what an operator
 * did on their own machine.
 */
export function createFileAuditTrailStore(filePath: string): AuditTrailStore {
  const directory = path.dirname(filePath);

  return {
    async load() {
      try {
        return JSON.parse(await readFile(filePath, "utf8")) as unknown;
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? (error as { code?: unknown }).code
            : undefined;
        if (code === "ENOENT") return [];
        // A corrupted file must not stop the panel from starting.
        return [];
      }
    },
    async save(entries: readonly AuditEntry[]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporaryPath = `${filePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(entries, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, filePath);
    },
  };
}
