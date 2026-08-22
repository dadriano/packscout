import { formatByteSize } from "../../format.ts";
import type { DownloadState } from "../../hooks/useLogExport.ts";

/**
 * The controls for reading the past, and for taking it away with you.
 *
 * The row states what mode the pane is in before it offers anything to press.
 * "Reading worker from the first byte of its log" and "live" look identical
 * from a distance and mean opposite things, so the sentence comes first and the
 * buttons follow it.
 *
 * Both file controls say what they will produce. The export is the filtered
 * view, which is usually a few hundred lines; the raw download is the whole
 * file, which is occasionally enormous — so it carries its size, and a service
 * has to be in focus before it can be asked for at all.
 */

export interface LogHistoryBarProps {
  loading: boolean;
  startNotice: string | null;
  detachedNotice: string | null;
  detached: boolean;
  atEnd: boolean;
  focusedService: string | null;
  rawSizeBytes: number | null;
  onJumpToStart: () => void;
  onLoadMore: () => void;
  onReturnToLive: () => void;
  onExportVisible: () => void;
  onDownloadRaw: () => void;
  downloadState: DownloadState;
  downloadError: string | null;
  error: string | null;
  onDismissError: () => void;
}

export function LogHistoryBar({
  loading,
  startNotice,
  detachedNotice,
  detached,
  atEnd,
  focusedService,
  rawSizeBytes,
  onJumpToStart,
  onLoadMore,
  onReturnToLive,
  onExportVisible,
  onDownloadRaw,
  downloadState,
  downloadError,
  error,
  onDismissError,
}: LogHistoryBarProps) {
  const state = detachedNotice ?? startNotice;

  return (
    <div className="panel-log-history">
      <div className="panel-log-toolbar-row">
        <span className="panel-log-history-state" role="status">
          {loading
            ? "Reading older output…"
            : (state ?? "Scroll up to read further back.")}
        </span>

        <button
          type="button"
          className="panel-button"
          onClick={onJumpToStart}
          disabled={focusedService === null}
          title={
            focusedService === null
              ? "Focus a single service to read its log from the start"
              : `Read ${focusedService} from the first byte of its log`
          }
        >
          Read from the start
        </button>

        {detached ? (
          <>
            <button
              type="button"
              className="panel-button"
              onClick={onLoadMore}
              disabled={atEnd || loading}
            >
              {atEnd ? "End of file" : "Read the next page"}
            </button>
            <button type="button" className="panel-button" onClick={onReturnToLive}>
              Return to live
            </button>
          </>
        ) : null}

        <button type="button" className="panel-button" onClick={onExportVisible}>
          Export visible lines
        </button>

        <button
          type="button"
          className="panel-button"
          onClick={onDownloadRaw}
          disabled={focusedService === null || downloadState === "working"}
          title={
            focusedService === null
              ? "Focus a single service to download its log file"
              : `Download the whole ${focusedService}.log file`
          }
        >
          {downloadState === "working"
            ? "Downloading…"
            : `Download raw file${
                rawSizeBytes === null ? "" : ` (${formatByteSize(rawSizeBytes)})`
              }`}
        </button>
      </div>

      {(error ?? downloadError) !== null ? (
        <p className="panel-notice" role="alert">
          {error ?? downloadError}{" "}
          {error ? (
            <button type="button" className="panel-button" onClick={onDismissError}>
              Dismiss
            </button>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
