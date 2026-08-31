"use client";

import { useMemo, useSyncExternalStore } from "react";
import {
  presentLastKnownPackScoutEvV3,
  type PackScoutDisplayedEvV3,
  type PublicRepackSummaryV3,
} from "@packscout/contracts";

const CLOCK_INTERVAL_MS = 60_000;
type PublicPrice = PublicRepackSummaryV3["price"];

function confidenceReferenceMillis(estimate: PackScoutDisplayedEvV3): number | null {
  if (estimate.status === "unavailable") return null;
  return Date.parse(estimate.status === "last_known"
    ? estimate.confidenceEvaluatedAt
    : estimate.calculatedAt);
}

/** The contract owns confidence decay; EV values and observation times never change. */
export function resolvePackScoutEvV3AtTime(
  estimate: PackScoutDisplayedEvV3,
  price: PublicPrice,
  nowMillis: number,
): PackScoutDisplayedEvV3 {
  if (estimate.status === "unavailable") return estimate;
  const calculationPriceUsdMinor = estimate.status === "last_known"
    ? estimate.calculationPriceUsdMinor
    : price.usdComparison.status === "available"
      ? price.usdComparison.value.minorUnits
      : null;
  if (calculationPriceUsdMinor === null) return estimate;
  return presentLastKnownPackScoutEvV3({
    estimate,
    calculationPriceUsdMinor,
    referenceTimeIso: new Date(Math.max(
      nowMillis, confidenceReferenceMillis(estimate)!,
    )).toISOString(),
    ...(estimate.status === "last_known"
      ? { latestUnavailableReason: estimate.latestUnavailableReason }
      : {}),
  });
}

export type PackScoutEvClockStore = Readonly<{
  subscribe: (onStoreChange: () => void) => () => void;
  getSnapshot: () => number | null;
  getServerSnapshot: () => number | null;
}>;

const clockListeners = new Set<() => void>();
let clockTimer: number | null = null;

function scheduleClock() {
  if (clockTimer !== null) window.clearTimeout(clockTimer);
  for (const listener of clockListeners) listener();
  clockTimer = window.setTimeout(scheduleClock, CLOCK_INTERVAL_MS);
}

function checkVisibleClock() {
  if (document.visibilityState === "visible") scheduleClock();
}

/** All mounted EV cells share one timer and one pair of browser listeners. */
function subscribeClock(onStoreChange: () => void): () => void {
  const listener = () => onStoreChange();
  clockListeners.add(listener);
  if (clockListeners.size === 1) {
    scheduleClock();
    document.addEventListener("visibilitychange", checkVisibleClock);
    window.addEventListener("pageshow", scheduleClock);
  }
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0) {
      if (clockTimer !== null) window.clearTimeout(clockTimer);
      clockTimer = null;
      document.removeEventListener("visibilitychange", checkVisibleClock);
      window.removeEventListener("pageshow", scheduleClock);
    }
  };
}

/**
 * Preserve the served confidence through hydration, then update once per minute.
 * Visibility and page restoration also check the clock; there are no announcements
 * for passive confidence changes, and an absent estimate never starts a timer.
 */
export function createPackScoutEvClockStore(
  referenceMillis: number | null,
  monotonicNow: () => number = () => performance.now(),
): PackScoutEvClockStore {
  const mountedAt = referenceMillis === null ? 0 : monotonicNow();
  let latestSnapshot = referenceMillis ?? 0;
  return Object.freeze({
    subscribe(onStoreChange: () => void) {
      if (referenceMillis === null) return () => undefined;
      return subscribeClock(onStoreChange);
    },
    getSnapshot: () => {
      if (referenceMillis === null) return null;
      // Advance only by monotonic elapsed browser time from the trusted served
      // clock. A skewed local wall clock must neither age nor rejuvenate EV.
      const elapsed = Math.max(0, monotonicNow() - mountedAt);
      latestSnapshot = Math.max(
        latestSnapshot,
        referenceMillis + Math.floor(elapsed / CLOCK_INTERVAL_MS) * CLOCK_INTERVAL_MS,
      );
      return latestSnapshot;
    },
    getServerSnapshot: () => referenceMillis,
  });
}

export function useClockBoundPackScoutEv(
  estimate: PackScoutDisplayedEvV3,
  price: PublicPrice,
): PackScoutDisplayedEvV3 {
  const referenceMillis = confidenceReferenceMillis(estimate);
  const store = useMemo(() => createPackScoutEvClockStore(referenceMillis), [referenceMillis]);
  const clockMillis = useSyncExternalStore(
    store.subscribe, store.getSnapshot, store.getServerSnapshot,
  );
  return useMemo(() => clockMillis === null || clockMillis === referenceMillis
    ? estimate
    : resolvePackScoutEvV3AtTime(estimate, price, clockMillis),
  [clockMillis, estimate, price, referenceMillis]);
}
