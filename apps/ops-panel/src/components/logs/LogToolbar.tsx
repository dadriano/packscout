import type { LogConnectionStatus } from "../../hooks/useLogStream.ts";
import type {
  LogDisplayPreferences,
  TextSize,
  TimestampMode,
} from "../../logs/display-preferences.ts";
import { serviceBadgeVariables } from "../../logs/service-badge.ts";

/**
 * The controls above the pane.
 *
 * Visibility toggles are a *view* concern and are applied in the browser: the
 * connection carries every service at all times, so hiding a noisy one is
 * instant and turning it back on loses nothing. Nothing here reconnects.
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
  services: string[];
  hidden: ReadonlySet<string>;
  onToggleService: (service: string) => void;
  onFocusService: (service: string | null) => void;
  preferences: LogDisplayPreferences;
  onPreferenceChange: (patch: Partial<LogDisplayPreferences>) => void;
  paused: boolean;
  onPausedChange: (paused: boolean) => void;
  heldCount: number;
  bufferedCount: number;
  onCopyVisible: () => void;
  copyState: "idle" | "copied" | "failed";
}

export function LogToolbar({
  status,
  following,
  services,
  hidden,
  onToggleService,
  onFocusService,
  preferences,
  onPreferenceChange,
  paused,
  onPausedChange,
  heldCount,
  bufferedCount,
  onCopyVisible,
  copyState,
}: LogToolbarProps) {
  const viewingState: LogConnectionStatus | "browsing" =
    status === "live" && !following ? "browsing" : status;

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
          {paused ? "Resume" : "Pause"}
        </button>

        <button type="button" className="panel-button" onClick={onCopyVisible}>
          {copyState === "copied"
            ? "Copied"
            : copyState === "failed"
              ? "Copy unavailable"
              : "Copy visible"}
        </button>

        <span className="panel-log-count">
          {bufferedCount.toLocaleString("en-US")} lines buffered
        </span>
      </div>

      <fieldset className="panel-log-toolbar-row panel-log-fieldset">
        <legend>Services</legend>
        {services.length === 0 ? (
          <span className="panel-log-count">None discovered yet</span>
        ) : null}
        {services.map((service) => {
          const visible = !hidden.has(service);
          return (
            <span key={service} className="panel-log-service-toggle">
              <label style={serviceBadgeVariables(service)}>
                <input
                  type="checkbox"
                  checked={visible}
                  onChange={() => onToggleService(service)}
                />
                <span className="panel-log-service">{service}</span>
              </label>
              <button
                type="button"
                className="panel-log-focus"
                onClick={() => onFocusService(service)}
                title={`Show only ${service}`}
              >
                only
              </button>
            </span>
          );
        })}
        {services.length > 0 ? (
          <button
            type="button"
            className="panel-button"
            onClick={() => onFocusService(null)}
          >
            Show all
          </button>
        ) : null}
      </fieldset>

      <div className="panel-log-toolbar-row">
        <label className="panel-log-control">
          <input
            type="checkbox"
            checked={preferences.wrap}
            onChange={(event) =>
              onPreferenceChange({ wrap: event.target.checked })
            }
          />
          Wrap long lines
        </label>

        <label className="panel-log-control">
          <input
            type="checkbox"
            checked={preferences.ansi}
            onChange={(event) =>
              onPreferenceChange({ ansi: event.target.checked })
            }
          />
          Terminal colour
        </label>

        <label className="panel-log-control">
          Timestamps
          <select
            value={preferences.timestamps}
            onChange={(event) =>
              onPreferenceChange({
                timestamps: event.target.value as TimestampMode,
              })
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
      </div>
    </div>
  );
}
