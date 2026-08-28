import {
  PANEL_MARKER_SCOPE,
  type LogMarkerKind,
  type LogMarkerReason,
  type LogMarkerRecord,
} from "../api/panel-types.ts";

/**
 * Markers the browser raises about itself.
 *
 * A dropped connection, a pause that overran its bound, a buffer that had to
 * refuse rows — none of those are visible to the server, and all of them mean
 * the reader is looking at less than the whole truth. They enter the buffer as
 * ordinary marker rows so they render inline, in place, rather than as a banner
 * detached from the output they describe.
 *
 * Ids use a session counter: they only need to be unique inside one buffer,
 * which is reset on every reconnect anyway.
 */

export interface ClientMarkerFactory {
  (input: {
    kind?: LogMarkerKind;
    reason: LogMarkerReason;
    detail: string;
    service?: string;
    skippedLines?: number;
    observedAt?: string;
  }): LogMarkerRecord;
}

export function createClientMarkerFactory(
  now: () => Date = () => new Date(),
): ClientMarkerFactory {
  let sequence = 0;
  return ({ kind = "skipped", reason, detail, service, skippedLines, observedAt }) => {
    sequence += 1;
    const scope = service ?? PANEL_MARKER_SCOPE;
    const marker: LogMarkerRecord = {
      id: `marker:${scope}:0:0:${kind}:client-${sequence}`,
      kind,
      reason,
      service: scope,
      generation: 0,
      offset: 0,
      observedAt: observedAt ?? now().toISOString(),
      detail,
    };
    if (skippedLines !== undefined) marker.skippedLines = skippedLines;
    return marker;
  };
}

export const RECONNECTED_DETAIL =
  "Connection restored — the view was rebuilt, so anything written while it was down is not shown.";
