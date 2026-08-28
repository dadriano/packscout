/** Presentation helpers kept framework-free so they can be tested directly. */

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatByteSize(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "unknown";
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < BYTE_UNITS.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? String(Math.round(size)) : size.toFixed(1);
  return `${rounded} ${BYTE_UNITS[unit]}`;
}

export function formatTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "unknown";
  return new Date(parsed).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/** Wall-clock time to the second: dense enough for a log gutter. */
export function formatClockTime(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "--:--:--";
  return new Date(parsed).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/** A short, screen-reader-friendly age such as "12s ago" or "3m ago". */
export function formatAge(value: string, now: number = Date.now()): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "unknown";
  const seconds = Math.max(0, Math.round((now - parsed) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
