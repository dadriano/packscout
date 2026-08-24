"use client";

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

/**
 * Which face the application shell wears (closed-beta-access/007).
 *
 * "product" is today's full chrome: primary navigation, catalog search, and
 * the data-release status. "gateway" is the pared-back shell around the
 * landing and holding surfaces — brand, theme, and the account control (so
 * sign-in and sign-out stay reachable), but no navigation into surfaces the
 * visitor cannot use and no catalog search against a gate that would refuse
 * it.
 *
 * The mode is decided on the server per request and seeded through the
 * provider, so the first paint is already correct. Because the layout — and
 * the shell with it — survives client-side navigations, each page also
 * reports its own mode on arrival, exactly the way the data-release status
 * travels; crossing the gate in either direction re-dresses the shell
 * without a full load.
 */
export type ShellSurfaceMode = "product" | "gateway";

type ShellSurfaceContextValue = Readonly<{
  mode: ShellSurfaceMode;
  setMode: (mode: ShellSurfaceMode) => void;
}>;

const ShellSurfaceContext = createContext<ShellSurfaceContextValue | null>(
  null,
);

export function ShellSurfaceProvider({
  children,
  initialMode,
}: Readonly<{ children: ReactNode; initialMode: ShellSurfaceMode }>) {
  const [mode, setMode] = useState<ShellSurfaceMode>(initialMode);
  const value = useMemo(() => ({ mode, setMode }), [mode]);
  return (
    <ShellSurfaceContext.Provider value={value}>
      {children}
    </ShellSurfaceContext.Provider>
  );
}

/**
 * Rendered by each page to declare which shell face belongs around it.
 * Contributes no markup; the server-seeded mode carries the first paint and
 * this keeps soft navigations honest.
 */
export function ShellSurfaceReporter({
  mode,
}: Readonly<{ mode: ShellSurfaceMode }>) {
  const context = useContext(ShellSurfaceContext);
  const setMode = context?.setMode;
  useEffect(() => {
    setMode?.(mode);
  }, [mode, setMode]);
  return null;
}

export function useShellSurfaceMode(): ShellSurfaceMode {
  return useContext(ShellSurfaceContext)?.mode ?? "product";
}
