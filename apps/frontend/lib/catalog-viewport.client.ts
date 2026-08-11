"use client";

import { useSyncExternalStore } from "react";

const NARROW_INSPECTOR_QUERY = "(max-width: 720px)";

function subscribe(onChange: () => void) {
  const query = window.matchMedia(NARROW_INSPECTOR_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

export function useNarrowCatalogInspector(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(NARROW_INSPECTOR_QUERY).matches,
    () => false,
  );
}
