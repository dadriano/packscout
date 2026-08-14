"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { PublicRepackHeat } from "@packscout/contracts";

const MAXIMUM_BROWSER_TIMEOUT_MS = 2_147_483_647;
const DEADLINE_SETTLE_MS = 25;

function parsedDeadline(expiresAt: string | null): number | null {
  if (expiresAt === null) return null;
  const deadline = Date.parse(expiresAt);
  return Number.isFinite(deadline) ? deadline : null;
}

export function millisecondsUntilRepackHeatExpiry(
  expiresAt: string,
  now: number,
): number | null {
  const deadline = parsedDeadline(expiresAt);
  if (deadline === null) return null;
  return Math.max(0, deadline - now);
}

export function expireCurrentRepackHeat(
  heat: PublicRepackHeat,
): PublicRepackHeat {
  if (heat.status !== "current") return heat;
  return Object.freeze({
    status: "expired" as const,
    signal: null,
    lastCalculatedAt: heat.signal.calculatedAt,
    expiredAt: heat.signal.expiresAt,
  });
}

export function resolveRepackHeatAtTime(
  heat: PublicRepackHeat,
  now: number,
): PublicRepackHeat {
  if (heat.status !== "current") return heat;
  const remaining = millisecondsUntilRepackHeatExpiry(
    heat.signal.expiresAt,
    now,
  );
  return remaining === 0 ? expireCurrentRepackHeat(heat) : heat;
}

function serverDeadlineSnapshot(): false {
  return false;
}

/**
 * Keeps the server-rendered signal through hydration, then expires it at its
 * public deadline even when no newer Convex frame arrives. This is deliberately
 * not a live region: an elapsed timing signal should stop looking current
 * without announcing every simulated frame to assistive technology.
 */
export function useDeadlineBoundRepackHeat(
  heat: PublicRepackHeat,
): PublicRepackHeat {
  const expiresAt = heat.status === "current" ? heat.signal.expiresAt : null;
  const deadline = parsedDeadline(expiresAt);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (deadline === null) return () => undefined;

      let timer: number | null = null;
      const schedule = () => {
        if (timer !== null) window.clearTimeout(timer);
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
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
    [deadline],
  );
  const getSnapshot = useCallback(
    () => deadline !== null && Date.now() >= deadline,
    [deadline],
  );
  const deadlineElapsed = useSyncExternalStore(
    subscribe,
    getSnapshot,
    serverDeadlineSnapshot,
  );

  return useMemo(
    () => deadlineElapsed ? expireCurrentRepackHeat(heat) : heat,
    [deadlineElapsed, heat],
  );
}
