import { useCallback, useEffect, useState } from "react";
import { fetchRawLogFile } from "../api/log-history-client.ts";
import {
  exportFileName,
  renderExportDocument,
  renderGroupText,
} from "../logs/export.ts";
import type { FactsLookup, VisibleGroup } from "../logs/line-groups.ts";

/**
 * Getting output out of the panel: clipboard, text file, raw log file.
 *
 * All three work from the *groups* the view admitted rather than from the rows
 * it drew, so a folded stack trace leaves as the event it is. The rendering
 * rules live in `logs/export.ts`; this hook owns only the browser-shaped parts —
 * the clipboard, an object URL, and the short-lived "Copied" acknowledgement
 * that tells an operator the keystroke landed.
 *
 * The raw download is the one place the panel holds a whole file at once. The
 * server streams it, and the browser materialises it only long enough to write
 * it to disk; the control says how large that will be before it is pressed, so
 * a gigabyte is a decision rather than a surprise.
 */

export type CopyState = "idle" | "copied" | "failed";
export type DownloadState = "idle" | "working" | "failed";

export interface LogExportState {
  copyState: CopyState;
  copyVisible: () => void;
  copyGroup: (groupId: string) => void;
  exportVisible: () => void;
  downloadState: DownloadState;
  downloadError: string | null;
  downloadRaw: (service: string) => void;
}

export interface UseLogExportOptions {
  groups: readonly VisibleGroup[];
  facts: FactsLookup;
  /** The focused service, or null when several are on screen. */
  scope: string | null;
  filterActive: boolean;
  matched: number;
  total: number;
}

function saveBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on the next turn: the click starts the save synchronously, but the
  // browser still needs the URL to be alive when it does.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function useLogExport({
  groups,
  facts,
  scope,
  filterActive,
  matched,
  total,
}: UseLogExportOptions): LogExportState {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [downloadState, setDownloadState] = useState<DownloadState>("idle");
  const [downloadError, setDownloadError] = useState<string | null>(null);

  useEffect(() => {
    if (copyState === "idle") return;
    const timer = setTimeout(() => setCopyState("idle"), 2_000);
    return () => clearTimeout(timer);
  }, [copyState]);

  const copyText = useCallback((text: string) => {
    const clipboard = navigator.clipboard;
    if (!clipboard) {
      setCopyState("failed");
      return;
    }
    clipboard.writeText(text).then(
      () => setCopyState("copied"),
      () => setCopyState("failed"),
    );
  }, []);

  const copyVisible = useCallback(() => {
    copyText(
      groups
        .map((group) => renderGroupText(group, facts, { prefixService: scope === null }))
        .join("\n"),
    );
  }, [copyText, facts, groups, scope]);

  const copyGroup = useCallback(
    (groupId: string) => {
      const group = groups.find((candidate) => candidate.id === groupId);
      if (!group) {
        setCopyState("failed");
        return;
      }
      copyText(renderGroupText(group, facts, { prefixService: scope === null }));
    },
    [copyText, facts, groups, scope],
  );

  const exportVisible = useCallback(() => {
    const at = new Date();
    const document = renderExportDocument({
      groups,
      facts,
      scope,
      at,
      filterActive,
      matched,
      total,
    });
    saveBlob(
      exportFileName(scope, at),
      new Blob([document], { type: "text/plain;charset=utf-8" }),
    );
  }, [facts, filterActive, groups, matched, scope, total]);

  const downloadRaw = useCallback((service: string) => {
    setDownloadState("working");
    setDownloadError(null);
    fetchRawLogFile(service)
      .then((blob) => {
        saveBlob(`${service}.log`, blob);
        setDownloadState("idle");
      })
      .catch((cause: unknown) => {
        setDownloadState("failed");
        setDownloadError(
          cause instanceof Error
            ? cause.message
            : "The panel could not download that log file.",
        );
      });
  }, []);

  return {
    copyState,
    copyVisible,
    copyGroup,
    exportVisible,
    downloadState,
    downloadError,
    downloadRaw,
  };
}
