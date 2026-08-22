/**
 * How the log pane looks, remembered per browser.
 *
 * These are reading preferences, not session state: an operator who turns
 * wrapping off and text size up has said something about their screen, and
 * being asked again on every reload is friction with no upside. They are stored
 * locally rather than on the server because the panel deliberately has no
 * account system to hang them on.
 *
 * Stored values are untrusted input like any other: a hand-edited or
 * stale-shaped entry falls back to the default rather than reaching the UI.
 */

export const LOG_DISPLAY_PREFERENCES_KEY = "packscout.ops-panel.logs.display";

export type TimestampMode = "absolute" | "relative" | "off";
export type TextSize = "small" | "medium" | "large";

export interface LogDisplayPreferences {
  /** Wrap long lines instead of scrolling them horizontally. */
  wrap: boolean;
  timestamps: TimestampMode;
  textSize: TextSize;
  /** Render terminal colour rather than the canonical plain text. */
  ansi: boolean;
}

export const DEFAULT_LOG_DISPLAY_PREFERENCES: Readonly<LogDisplayPreferences> =
  Object.freeze({
    wrap: false,
    timestamps: "relative",
    textSize: "medium",
    ansi: true,
  });

const TIMESTAMP_MODES: readonly TimestampMode[] = ["absolute", "relative", "off"];
const TEXT_SIZES: readonly TextSize[] = ["small", "medium", "large"];

/** The narrow slice of `Storage` this module needs, so tests need no browser. */
export interface PreferenceStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function pick<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

export function parseLogDisplayPreferences(
  raw: string | null,
): LogDisplayPreferences {
  if (!raw) return { ...DEFAULT_LOG_DISPLAY_PREFERENCES };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_LOG_DISPLAY_PREFERENCES };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ...DEFAULT_LOG_DISPLAY_PREFERENCES };
  }
  const candidate = parsed as Partial<Record<keyof LogDisplayPreferences, unknown>>;
  return {
    wrap:
      typeof candidate.wrap === "boolean"
        ? candidate.wrap
        : DEFAULT_LOG_DISPLAY_PREFERENCES.wrap,
    timestamps: pick(
      candidate.timestamps,
      TIMESTAMP_MODES,
      DEFAULT_LOG_DISPLAY_PREFERENCES.timestamps,
    ),
    textSize: pick(
      candidate.textSize,
      TEXT_SIZES,
      DEFAULT_LOG_DISPLAY_PREFERENCES.textSize,
    ),
    ansi:
      typeof candidate.ansi === "boolean"
        ? candidate.ansi
        : DEFAULT_LOG_DISPLAY_PREFERENCES.ansi,
  };
}

export function readLogDisplayPreferences(
  store: PreferenceStore | undefined,
): LogDisplayPreferences {
  if (!store) return { ...DEFAULT_LOG_DISPLAY_PREFERENCES };
  try {
    return parseLogDisplayPreferences(store.getItem(LOG_DISPLAY_PREFERENCES_KEY));
  } catch {
    // Private browsing modes can throw on access; defaults are still usable.
    return { ...DEFAULT_LOG_DISPLAY_PREFERENCES };
  }
}

export function writeLogDisplayPreferences(
  store: PreferenceStore | undefined,
  preferences: LogDisplayPreferences,
): void {
  if (!store) return;
  try {
    store.setItem(LOG_DISPLAY_PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // A preference that cannot be saved is not worth failing the view over.
  }
}

/** Row heights the virtualizer needs; kept beside the sizes that produce them. */
export const TEXT_SIZE_ROW_HEIGHT: Readonly<Record<TextSize, number>> =
  Object.freeze({ small: 17, medium: 20, large: 24 });
