import { useCallback, useMemo } from "react";
import type { LogLineRecord, LogSource } from "../api/panel-types.ts";
import type { FactsLookup } from "../logs/line-groups.ts";
import {
  buildSourceRail,
  createObservationLedger,
  type SourceRailEntry,
} from "../logs/source-rail.ts";
import { useNow } from "./useNow.ts";

/**
 * The rail's numbers, and the ledger that earns them.
 *
 * Observation is fed from the live stream only — never from the initial window —
 * so every count here describes something this panel watched happen. The rail is
 * then rebuilt on a clock rather than on arrivals: liveness and relative times
 * go stale on their own, and a service that has gone quiet has to be able to say
 * so without needing a line to arrive and prompt it.
 */

/** Slow enough to be cheap, fast enough that "writing" is believable. */
const RAIL_TICK_MS = 2_000;

export interface ServiceRailState {
  entries: SourceRailEntry[];
  /** The instant the entries were computed for. */
  now: number;
  /** Hand to `useLogStream`'s `onLines`. */
  observe: (lines: readonly LogLineRecord[]) => void;
}

export interface ServiceRailInput {
  sources: readonly LogSource[];
  hidden: ReadonlySet<string>;
  focusedService: string | null;
  facts: FactsLookup;
}

export function useServiceRail({
  sources,
  hidden,
  focusedService,
  facts,
}: ServiceRailInput): ServiceRailState {
  const ledger = useMemo(() => createObservationLedger(), []);
  const now = useNow(RAIL_TICK_MS);

  const observe = useCallback(
    (lines: readonly LogLineRecord[]) => {
      for (const record of lines) {
        const { severity } = facts({ type: "line", ...record });
        const at = Date.parse(record.observedAt);
        ledger.record(record.service, severity, Number.isFinite(at) ? at : Date.now());
      }
    },
    [facts, ledger],
  );

  const entries = useMemo(
    () =>
      buildSourceRail({
        sources,
        observations: ledger.snapshot(now),
        hidden,
        focusedService,
        openedAtMs: ledger.openedAtMs(),
        nowMs: now,
      }),
    [focusedService, hidden, ledger, now, sources],
  );

  return { entries, now, observe };
}
