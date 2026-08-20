import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useTheme } from "../hooks/useTheme";
import { useSession } from "../providers/session";
import { useToast } from "../providers/toast";

const baseNavigation = [{ to: "/", label: "Overview" }];

function CloseIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="M5 5l10 10M15 5L5 15" />
    </svg>
  );
}

function ThemeIcon({ dark }: { dark: boolean }) {
  return dark ? (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41" />
    </svg>
  ) : (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z" />
    </svg>
  );
}

export function AdminLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { resolvedTheme, setTheme } = useTheme();
  const { status, signOut } = useSession();
  const { showToast } = useToast();
  const [navOpenedAt, setNavOpenedAt] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const navOpen = navOpenedAt === location.pathname;
  const title =
    location.pathname === "/"
      ? "Overview"
      : location.pathname === "/operators"
        ? "Operators"
        : location.pathname.startsWith("/providers")
          ? "Data Providers"
        : location.pathname.startsWith("/operations")
          ? "Pipeline Status"
        : location.pathname.startsWith("/runs")
          ? "Import Runs"
        : location.pathname.startsWith("/quarantine")
          ? "Quarantine"
        : location.pathname.startsWith("/background-work")
          ? "Background Work"
        : location.pathname.startsWith("/alerts")
          ? "Operational Alerts"
        : "Not found";
  useDocumentTitle(title);

  useEffect(() => {
    if (!navOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setNavOpenedAt(null);
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [navOpen]);

  if (status.phase !== "authenticated") return null;
  const { session } = status;
  const canManageOperators = session.permissions.includes("operators:manage");
  const canViewProviders = session.permissions.includes("providers:view");
  const workspaceNavigation = [
    ...baseNavigation,
    ...(canManageOperators ? [{ to: "/operators", label: "Operators" }] : []),
  ];
  const pipelineNavigation = canViewProviders
    ? [
        { to: "/operations", label: "Status" },
        { to: "/providers", label: "Providers" },
        { to: "/runs", label: "Import Runs" },
        { to: "/quarantine", label: "Quarantine" },
        { to: "/background-work", label: "Background Work" },
        { to: "/alerts", label: "Alerts" },
      ]
    : [];

  return (
    <div className="admin-layout" data-nav-open={navOpen ? "true" : "false"}>
      <button
        type="button"
        className="admin-sidebar-backdrop"
        aria-label="Close navigation"
        aria-hidden={!navOpen}
        tabIndex={navOpen ? 0 : -1}
        onClick={() => setNavOpenedAt(null)}
      />

      <aside className="admin-sidebar" aria-label="Admin navigation">
        <div className="admin-sidebar__brand">
          <NavLink to="/" className="admin-brand" aria-label="Packscout admin overview">
            <span className="admin-brand__mark" aria-hidden="true">
              PS
            </span>
            <span>
              <small>Operations console</small>
              <strong>Packscout</strong>
            </span>
          </NavLink>
          <button
            type="button"
            className="admin-icon-button admin-sidebar__close"
            aria-label="Close navigation"
            onClick={() => setNavOpenedAt(null)}
          >
            <CloseIcon />
          </button>
        </div>

        <nav className="admin-sidebar__nav">
          <section className="admin-nav-section">
            <h2>Workspace</h2>
            {workspaceNavigation.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === "/"}
                className={({ isActive }) =>
                  `admin-nav-link${isActive ? " is-active" : ""}`
                }
                onClick={() => setNavOpenedAt(null)}
              >
                {item.label}
              </NavLink>
            ))}
          </section>
          {pipelineNavigation.length > 0 ? (
            <section className="admin-nav-section">
              <h2>Data pipeline</h2>
              {pipelineNavigation.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) => `admin-nav-link${isActive ? " is-active" : ""}`}
                  onClick={() => setNavOpenedAt(null)}
                >
                  {item.label}
                </NavLink>
              ))}
            </section>
          ) : null}
        </nav>

        <div className="admin-sidebar__footer">
          <span className="admin-eyebrow">Active workspace</span>
          <p>{session.membership.organizationName}</p>
        </div>
      </aside>

      <div className="admin-layout__main">
        <header className="admin-topbar">
          <div className="admin-topbar__start">
            <button
              type="button"
              className="admin-icon-button admin-sidebar__toggle"
              aria-label="Open navigation"
              onClick={() => setNavOpenedAt(location.pathname)}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="M4 7h16M4 12h16M4 17h16" />
              </svg>
            </button>
            <div>
              <span className="admin-eyebrow">Field operations</span>
              <strong>Pack intelligence workspace</strong>
            </div>
          </div>
          <div className="admin-topbar__end">
            <div className="admin-operator-identity">
              <strong>{session.operator.displayName}</strong>
              <span>
                {session.membership.role === "admin"
                  ? "Administrator"
                  : "Data operator"}
              </span>
            </div>
            <button
              type="button"
              className="admin-button admin-button--secondary admin-sign-out"
              disabled={signingOut}
              onClick={() => {
                setSigningOut(true);
                void signOut()
                  .then(() => navigate("/login", { replace: true }))
                  .catch(() => {
                    setSigningOut(false);
                    showToast("Sign out failed. Try again.", "error");
                  });
              }}
            >
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
            <button
              type="button"
              className="admin-icon-button"
              aria-label={`Switch to ${resolvedTheme === "dark" ? "light" : "dark"} theme`}
              onClick={() =>
                setTheme(resolvedTheme === "dark" ? "light" : "dark")
              }
            >
              <ThemeIcon dark={resolvedTheme === "dark"} />
            </button>
          </div>
        </header>

        <main className="admin-main">
          <div className="admin-main__inner">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
