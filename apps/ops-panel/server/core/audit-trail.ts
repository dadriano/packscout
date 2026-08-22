/**
 * The panel's audit trail: every privileged attempt — succeeded, failed, and
 * rejected — in one bounded, persisted, reverse-chronological list.
 *
 * Framework-free. Persistence is injected as a store so the behavior (bounding,
 * ordering, survival across restarts) is provable without a filesystem, and so
 * later surfaces can reuse the same trail.
 */

export const AUDIT_OUTCOMES = ["succeeded", "failed", "rejected"] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export const AUDIT_TRAIL_LIMIT = 500;
const MAX_TEXT_LENGTH = 200;

export interface AuditEntry {
  id: string;
  recordedAt: string;
  action: string;
  method: string;
  route: string;
  outcome: AuditOutcome;
  /** Guard rejection code, when the attempt never reached its handler. */
  reason?: string;
  /** Short, secret-free summary of what the attempt did. */
  detail?: string;
}

export interface AuditEntryInput {
  action: string;
  method: string;
  route: string;
  outcome: AuditOutcome;
  reason?: string;
  detail?: string;
}

export interface AuditTrailStore {
  load(): Promise<unknown>;
  save(entries: readonly AuditEntry[]): Promise<void>;
}

export interface AuditTrail {
  /** Newest first. */
  list(options?: { limit?: number }): AuditEntry[];
  record(input: AuditEntryInput): Promise<AuditEntry>;
  size(): number;
}

export interface AuditTrailOptions {
  store: AuditTrailStore;
  limit?: number;
  now?: () => Date;
  createId?: () => string;
  onPersistenceError?: (error: unknown) => void;
}

/** Control characters would corrupt a log line or a terminal rendering it. */
function stripControlCharacters(value: string): string {
  let stripped = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    stripped += code < 0x20 || code === 0x7f ? " " : character;
  }
  return stripped;
}

/** Strip control characters and cap length: audit text is never a payload. */
export function sanitizeAuditText(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const cleaned = stripControlCharacters(value).trim();
  if (cleaned.length === 0) return fallback;
  return cleaned.length > MAX_TEXT_LENGTH
    ? `${cleaned.slice(0, MAX_TEXT_LENGTH - 1)}…`
    : cleaned;
}

function isAuditOutcome(value: unknown): value is AuditOutcome {
  return AUDIT_OUTCOMES.includes(value as AuditOutcome);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

/**
 * Accept only well-formed entries from persisted state. A corrupted or
 * hand-edited file degrades to the entries that still parse rather than
 * crashing the panel.
 */
export function parseAuditEntries(value: unknown): AuditEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: AuditEntry[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.length === 0) continue;
    if (!isIsoTimestamp(record.recordedAt)) continue;
    if (!isAuditOutcome(record.outcome)) continue;
    const action = sanitizeAuditText(record.action);
    const method = sanitizeAuditText(record.method);
    const route = sanitizeAuditText(record.route);
    if (!action || !method || !route) continue;
    const reason = sanitizeAuditText(record.reason);
    const detail = sanitizeAuditText(record.detail);
    entries.push({
      id: record.id,
      recordedAt: record.recordedAt,
      action,
      method,
      route,
      outcome: record.outcome,
      ...(reason ? { reason } : {}),
      ...(detail ? { detail } : {}),
    });
  }
  return entries;
}

export function sortNewestFirst(entries: readonly AuditEntry[]): AuditEntry[] {
  return [...entries].sort((left, right) => {
    const byTime = right.recordedAt.localeCompare(left.recordedAt);
    return byTime === 0 ? right.id.localeCompare(left.id) : byTime;
  });
}

let fallbackCounter = 0;

function defaultId(): string {
  fallbackCounter = (fallbackCounter + 1) % 1_000_000;
  const random =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${fallbackCounter.toString(36)}`;
  return random;
}

export async function createAuditTrail({
  store,
  limit = AUDIT_TRAIL_LIMIT,
  now = () => new Date(),
  createId = defaultId,
  onPersistenceError,
}: AuditTrailOptions): Promise<AuditTrail> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("The audit trail limit must be a positive integer.");
  }

  let loaded: unknown = [];
  try {
    loaded = await store.load();
  } catch (error) {
    onPersistenceError?.(error);
  }
  // Bound on load as well: a file that grew elsewhere never grows the panel.
  let entries = sortNewestFirst(parseAuditEntries(loaded)).slice(0, limit);
  let persistence: Promise<void> = Promise.resolve();

  function persist(): void {
    const pending = [...entries];
    persistence = persistence
      .then(() => store.save(pending))
      .catch((error) => {
        onPersistenceError?.(error);
      });
  }

  return {
    list({ limit: requested } = {}) {
      const size =
        requested === undefined
          ? entries.length
          : Math.max(0, Math.min(requested, entries.length));
      return entries.slice(0, size);
    },
    async record(input) {
      const entry: AuditEntry = {
        id: createId(),
        recordedAt: now().toISOString(),
        action: sanitizeAuditText(input.action, "unknown action"),
        method: sanitizeAuditText(input.method, "UNKNOWN"),
        route: sanitizeAuditText(input.route, "unknown"),
        outcome: input.outcome,
        ...(sanitizeAuditText(input.reason)
          ? { reason: sanitizeAuditText(input.reason) }
          : {}),
        ...(sanitizeAuditText(input.detail)
          ? { detail: sanitizeAuditText(input.detail) }
          : {}),
      };
      entries = [entry, ...entries].slice(0, limit);
      persist();
      await persistence;
      return entry;
    },
    size: () => entries.length,
  };
}
