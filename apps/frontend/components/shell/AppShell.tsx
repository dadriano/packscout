import { AccountControl } from "@/components/auth/AccountControl.client";
import { BrandLogo } from "./BrandLogo";
import { RouteFocusManager } from "./RouteFocusManager.client";
import {
  DataReleaseStatusProvider,
} from "./DataReleaseStatus.client";
import { ShellProductChrome } from "./ShellChrome.client";
import {
  ShellSurfaceProvider,
  type ShellSurfaceMode,
} from "./ShellSurface.client";
import { ThemeControl } from "./ThemeControl.client";

/**
 * The application shell. `initialSurface` is the server-resolved face for
 * this request (closed-beta-access/007): "product" renders today's full
 * chrome, "gateway" strips the navigation, catalog search, and release
 * status around the landing and holding surfaces. The account and theme
 * controls render in both faces, so signing in and signing out stay
 * reachable from every state. Pages re-declare their face on soft
 * navigations through {@link ShellSurfaceProvider}'s reporter.
 */
export function AppShell({
  children,
  initialSurface,
}: {
  children: React.ReactNode;
  initialSurface: ShellSurfaceMode;
}) {
  return (
    <DataReleaseStatusProvider>
      <ShellSurfaceProvider initialMode={initialSurface}>
        <div className="app-shell">
          <a className="skip-link" href="#main-content">
            Skip to main content
          </a>
          <header className="app-header">
            <div className="app-header__inner">
              <BrandLogo />
              <ShellProductChrome />
              <AccountControl />
              <ThemeControl />
            </div>
          </header>
          <RouteFocusManager />
          <main className="app-content" id="main-content">
            {children}
          </main>
        </div>
      </ShellSurfaceProvider>
    </DataReleaseStatusProvider>
  );
}
