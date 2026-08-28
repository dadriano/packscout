import type { LogConnectionStatus } from "../../hooks/useLogStream.ts";
import type {
  LogDisplayPreferences,
  TextSize,
  TimestampMode,
} from "../../logs/display-preferences.ts";

/**
 * The controls above the pane.
 *
 * Everything here is a *view* decision applied in the browser: the connection
 * carries every service at all times, so nothing on this row reconnects, and
 * turning something back on loses nothing.
 *
 * The reset is deliberately two-step rather than a confirm dialog. It throws
 * away work an operator built up over a session — hidden services, remembered
 * searches, reading preferences — so it should take a second press, and the
 * second press should say what it is about to do.
 */

const STATUS_LABEL: Record<LogConnectionStatus | "browsing", string> = {
  connecting: "Connecting",
  live: "Live",
  reconnecting: "Reconnecting",
  paused: "Paused",
  browsing: "Browsing history",
};

const TIMESTAMP_LABEL: Record<TimestampMode, string> = {
  relative: "Relative",
  absolute: "Absolute",
  off: "Hidden",
};

const TEXT_SIZE_LABEL: Record<TextSize, string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
};

export interface LogToolbarProps {
  status: LogConnectionStatus;
  following: boolean;
  /** True while a detached history read is showing instead of the tail. */
  browsing: boolean;
  preferences: LogDisplayPreferences;
  onPreferenceChange: (patch: Partial<LogDisplayPreferences>) => void;
  paused: boolean;
  onPausedChange: (paused: boolean) => void;
  heldCount: number;
  bufferedCount: number;
  onCopyVisible: () => void;
  copyState: "idle" | "copied" | "failed";
  onShowShortcuts: () => void;
  resetArmed: boolean;
  onResetPreferences: () => void;
}

export function LogToolbar({
  status,
  following,
  browsing,
  preferences,
  onPreferenceChange,
  paused,
  onPausedChange,
  heldCount,
  bufferedCount,
  onCopyVisible,
  copyState,
  onShowShortcuts,
  resetArmed,
  onResetPreferences,
}: LogToolbarProps) {
  // A detached history read looks like a paused stream from the outside and
  // means something else entirely, so it says so rather than borrowing a label.
  const viewingState: LogConnectionStatus | "browsing" =
    browsing || (status === "live" && !following) ? "browsing" : status;

  return (
    <div className="panel-log-toolbar">
      <div className="panel-log-toolbar-row">
        <span
          className="panel-status"
          data-tone={
            viewingState === "live"
              ? "live"
              : viewingState === "reconnecting"
                ? "failed"
                : "idle"
          }
          role="status"
        >
          {STATUS_LABEL[viewingState]}
          {viewingState === "paused" && heldCount > 0 ? ` · ${heldCount} held` : ""}
        </span>

        <button
          type="button"
          className="panel-button"
          onClick={() => onPausedChange(!paused)}
          aria-pressed={paused}
        >
          {browsing ? "Return to live" : paused ? "Resume" : "Pause"}
        </button>

        <button type="button" className="panel-button" onClick={onCopyVisible}>
          {copyState === "copied"
            ? "Copied"
            : copyState === "failed"
              ? "Copy unavailable"
              : "Copy visible"}
        </button>

        <button type="button" className="panel-button" onClick={onShowShortcuts}>
          Shortcuts
        </button>

        <span className="panel-log-count">
          {bufferedCount.toLocaleString("en-US")} lines buffered
        </span>
      </div>

      <div className="panel-log-toolbar-row">
        <label className="panel-log-control">
          <input
            type="checkbox"
            checked={preferences.wrap}
            onChange={(event) => onPreferenceChange({ wrap: event.target.checked })}
          />
          Wrap long lines
        </label>

        <label className="panel-log-control">
          <input
            type="checkbox"
            checked={preferences.ansi}
            onChange={(event) => onPreferenceChange({ ansi: event.target.checked })}
          />
          Terminal colour
        </label>

        <label className="panel-log-control">
          Timestamps
          <select
            value={preferences.timestamps}
            onChange={(event) =>
              onPreferenceChange({ timestamps: event.target.value as TimestampMode })
            }
          >
            {(Object.keys(TIMESTAMP_LABEL) as TimestampMode[]).map((mode) => (
              <option key={mode} value={mode}>
                {TIMESTAMP_LABEL[mode]}
              </option>
            ))}
          </select>
        </label>

        <label className="panel-log-control">
          Text size
          <select
            value={preferences.textSize}
            onChange={(event) =>
              onPreferenceChange({ textSize: event.target.value as TextSize })
            }
          >
            {(Object.keys(TEXT_SIZE_LABEL) as TextSize[]).map((size) => (
              <option key={size} value={size}>
                {TEXT_SIZE_LABEL[size]}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className="panel-button"
          onClick={onResetPreferences}
          aria-pressed={resetArmed}
        >
          {resetArmed
            ? "Confirm: forget hidden services, searches, and display settings"
            : "Reset saved settings"}
        </button>
      </div>
    </div>
  );
}
