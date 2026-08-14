"use client";

import { useSyncExternalStore } from "react";
import {
  applyResolvedTheme,
  persistTheme,
  ResolvedTheme,
  resolveInitialTheme,
} from "@/lib/theme.client";

const THEME_CHANGE_EVENT = "packscout:theme-change";

function subscribeToTheme(onStoreChange: () => void) {
  window.addEventListener(THEME_CHANGE_EVENT, onStoreChange);
  return () => window.removeEventListener(THEME_CHANGE_EVENT, onStoreChange);
}

function getThemeSnapshot(): ResolvedTheme | null {
  return resolveInitialTheme(
    document.documentElement.dataset.theme,
    window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
}

function SunIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="13" viewBox="0 0 16 16" width="13">
      <circle cx="8" cy="8" r="2.4" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 1.2v1.3M8 13.5v1.3M1.2 8h1.3M13.5 8h1.3M3.2 3.2l.9.9M11.9 11.9l.9.9M12.8 3.2l-.9.9M4.1 11.9l-.9.9" stroke="currentColor" strokeLinecap="round" strokeWidth="1.1" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="13" viewBox="0 0 16 16" width="13">
      <path d="M12.8 10.2A5.2 5.2 0 0 1 5.8 3.1a5.4 5.4 0 1 0 7 7.1Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.3" />
    </svg>
  );
}

export function ThemeControl() {
  const theme = useSyncExternalStore(
    subscribeToTheme,
    getThemeSnapshot,
    () => null,
  );

  function toggleTheme() {
    const current = theme ?? getThemeSnapshot() ?? "light";
    const nextTheme = current === "dark" ? "light" : "dark";
    applyResolvedTheme(nextTheme);
    persistTheme(nextTheme);
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
  }

  const resultingTheme = theme === "dark" ? "light" : "dark";

  return (
    <div className="theme-control">
      <button
        aria-label={`Switch to ${resultingTheme} theme`}
        aria-pressed={theme === "dark"}
        className="theme-toggle"
        onClick={toggleTheme}
        type="button"
      >
        <span aria-hidden="true" className="theme-toggle__thumb" />
        <span className="theme-toggle__icon">
          <SunIcon />
        </span>
        <span className="theme-toggle__icon">
          <MoonIcon />
        </span>
      </button>
    </div>
  );
}
