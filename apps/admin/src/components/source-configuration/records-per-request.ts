export const DEFAULT_RECORDS_PER_REQUEST = 500;

export const RECORDS_PER_REQUEST_HELP =
  "Smaller values use less memory. Larger values can finish backfills faster. The source may return fewer.";

export const RECORDS_PER_REQUEST_ERROR =
  "Enter a whole number from 1 to 5,000.";

export const RECORDS_PER_REQUEST_SAVED =
  "Saved. Applies to the next import run.";

export function parseRecordsPerRequest(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 5_000
    ? parsed
    : null;
}

export function recordsPerRequestDisplay(
  configured: number,
  activeRun: number | null,
): string {
  const next = configured.toLocaleString("en-US");
  if (activeRun !== null && activeRun !== configured) {
    return `Current run: ${activeRun.toLocaleString("en-US")}. Next run: ${next}.`;
  }
  return next;
}
