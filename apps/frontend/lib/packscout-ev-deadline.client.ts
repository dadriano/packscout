"use client";

import { useMemo, useSyncExternalStore } from "react";
import type { PackScoutPublicEvV3 } from "@packscout/contracts";

const MAXIMUM_BROWSER_TIMEOUT_MS = 2_147_483_647;
const DEADLINE_SETTLE_MS = 25;

export function packScoutEvDeadlineMillis(
  estimate: PackScoutPublicEvV3,
): number | null {
  if (estimate.status !== "current") return null;
  const deadline = Date.parse(estimate.expiresAt);
  return Number.isFinite(deadline) ? deadline : null;
}

/**
 * Converts a current estimate to the deterministic stale public state after
 * its exact 60-minute deadline, mirroring the server-side conversion: the
 * server clock is authoritative at query time and the browser only converts
 * presentation state, never metrics, confidence, rankings, or aggregates.
 */
export function expireCurrentPackScoutEvV3(
  estimate: PackScoutPublicEvV3,
  nowMillis: number,
): PackScoutPublicEvV3 {
  if (estimate.status !== "current") return estimate;
  return Object.freeze({
    status: "unavailable" as const,
    methodVersion: estimate.methodVersion,
    confidencePolicyVersion: estimate.confidencePolicyVersion,
    metrics: null,
    confidence: null,
    calculatedAt: new Date(nowMillis).toISOString(),
    dataAsOf: estimate.dataAsOf,
    reason: "SOURCE_DATA_STALE" as const,
  });
}

/**
 * A current estimate stays presentable through its exact deadline and
 * converts only strictly after it, matching
 * packScoutPublicEvV3IsPresentableAt. Historical and unavailable estimates
 * never convert.
 */
export function resolvePackScoutEvV3AtTime(
  estimate: PackScoutPublicEvV3,
  nowMillis: number,
): PackScoutPublicEvV3 {
  const deadline = packScoutEvDeadlineMillis(estimate);
  if (deadline === null || nowMillis <= deadline) return estimate;
  return expireCurrentPackScoutEvV3(estimate, nowMillis);
}

function serverDeadlineSnapshot(): false {
  return false;
}

export type PackScoutEvDeadlineStore = Readonly<{
  subscribe: (onStoreChange: () => void) => () => void;
  getSnapshot: () => boolean;
  getServerSnapshot: () => false;
}>;

/**
 * The deadline store behind useDeadlineBoundPackScoutEv. The snapshot flips
 * only strictly after the public deadline, the server snapshot is always
 * false so server render and hydration never disagree, and the subscription
 * schedules one wake-up at the deadline instead of polling clock ticks.
 */
export function createPackScoutEvDeadlineStore(
  deadline: number | null,
): PackScoutEvDeadlineStore {
  return Object.freeze({
    subscribe(onStoreChange: () => void) {
      if (deadline === null) return () => undefined;

      let timer: number | null = null;
      const schedule = () => {
        if (timer !== null) window.clearTimeout(timer);
        const remaining = deadline - Date.now();
        if (remaining < 0) {
          onStoreChange();
          return;
        }
        timer = window.setTimeout(
          schedule,
          Math.min(MAXIMUM_BROWSER_TIMEOUT_MS, remaining + DEADLINE_SETTLE_MS),
        );
      };
      const checkVisibleDeadline = () => {
        if (document.visibilityState === "visible") schedule();
      };

      schedule();
      document.addEventListener("visibilitychange", checkVisibleDeadline);
      window.addEventListener("pageshow", schedule);
      return () => {
        if (timer !== null) window.clearTimeout(timer);
        document.removeEventListener("visibilitychange", checkVisibleDeadline);
        window.removeEventListener("pageshow", schedule);
      };
    },
    getSnapshot: () => deadline !== null && Date.now() > deadline,
    getServerSnapshot: serverDeadlineSnapshot,
  });
}

/**
 * Keeps the server-rendered estimate through hydration, then converts it to
 * the unavailable stale state at its public deadline in an already-open page
 * without a reload. This is deliberately not a live region: an expired
 * estimate stops looking current without announcing clock ticks to assistive
 * technology, and the server snapshot is stable so hydration never disagrees
 * with the server render.
 */
export function useDeadlineBoundPackScoutEv(
  estimate: PackScoutPublicEvV3,
): PackScoutPublicEvV3 {
  const deadline = packScoutEvDeadlineMillis(estimate);
  const store = useMemo(() => createPackScoutEvDeadlineStore(deadline), [deadline]);
  const deadlineElapsed = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );

  // The conversion timestamp is the deadline itself (the first stale
  // millisecond), keeping the render pure and deterministic.
  return useMemo(
    () =>
      deadlineElapsed && deadline !== null
        ? expireCurrentPackScoutEvV3(estimate, deadline + 1)
        : estimate,
    [deadline, deadlineElapsed, estimate],
  );
}
