"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

export function RouteFocusManager() {
  const pathname = usePathname();
  const previousPathname = useRef(pathname);
  const historyNavigation = useRef(false);

  useEffect(() => {
    function markHistoryNavigation() {
      historyNavigation.current = true;
    }

    window.addEventListener("popstate", markHistoryNavigation);
    return () => window.removeEventListener("popstate", markHistoryNavigation);
  }, []);

  useEffect(() => {
    if (previousPathname.current === pathname) return;
    previousPathname.current = pathname;

    if (historyNavigation.current) {
      historyNavigation.current = false;
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>("[data-route-heading]")?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pathname]);

  return null;
}
