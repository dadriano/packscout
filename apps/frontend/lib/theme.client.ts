export const PACKSCOUT_THEME_STORAGE_KEY = "packscout.theme";

export type ResolvedTheme = "light" | "dark";

export function isResolvedTheme(value: unknown): value is ResolvedTheme {
  return value === "light" || value === "dark";
}

export function resolveInitialTheme(
  storedValue: unknown,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (isResolvedTheme(storedValue)) return storedValue;
  return systemPrefersDark ? "dark" : "light";
}

export function applyResolvedTheme(theme: ResolvedTheme): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;

  const themeMeta = document.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"]',
  );
  themeMeta?.setAttribute("content", theme === "dark" ? "#030b13" : "#f8f9fc");
}

export function readStoredTheme(): ResolvedTheme | null {
  try {
    const stored = window.localStorage.getItem(PACKSCOUT_THEME_STORAGE_KEY);
    return isResolvedTheme(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function persistTheme(theme: ResolvedTheme): void {
  try {
    window.localStorage.setItem(PACKSCOUT_THEME_STORAGE_KEY, theme);
  } catch {
    // Storage can be unavailable in privacy modes. The in-document choice still applies.
  }
}
