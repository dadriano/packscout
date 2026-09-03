import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useTheme } from "../hooks/useTheme";
import { useSession } from "../providers/session";
import { useToast } from "../providers/toast";
import { navigationSections, pageTitleForPath } from "../routes/admin-routes";

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
  useDocumentTitle(pageTitleForPath(location.pathname));

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
  const sections = navigationSections(session.permissions);

  return (
    <div className="admin-layout" data-nav-open={navOpen ? "true" : "false"}>
      <button
        type="button"
        className={`admin-sidebar-backdrop${navOpen ? " is-visible" : ""}`}
        aria-label="Close navigation"
        aria-hidden={!navOpen}
        tabIndex={navOpen ? 0 : -1}
        onClick={() => setNavOpenedAt(null)}
      />

      <aside className="admin-sidebar" aria-label="Admin navigation">
        <div className="admin-sidebar__brand">
          <NavLink
            to="/"
            className="admin-brand-lockup"
            aria-label="Packscout admin overview"
          >
            {/* Served from the app's public directory rather than imported, so
                the asset resolves the same way under the bundler and under the
                test runner, which does not process binary imports. */}
            <img
              className="admin-brand-mark"
              src="/brand/packscout-icon.png"
              alt=""
              aria-hidden="true"
              width={128}
              height={128}
            />
            <span>
              <span className="admin-brand-eyebrow">Operations console</span>
              <span className="admin-brand-title">Packscout</span>
            </span>
          </NavLink>
          <button
            type="button"
            className="admin-icon-button admin-sidebar-close"
            aria-label="Close navigation"
            onClick={() => setNavOpenedAt(null)}
          >
            <CloseIcon />
          </button>
        </div>

        <nav className="admin-sidebar__nav">
          {sections.map((section) => (
            <section key={section.id} className="admin-sidebar__section">
              <div className="admin-sidebar__heading">{section.heading}</div>
              <div className="admin-sidebar__list">
                {section.items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) =>
                      `admin-sidebar__link${isActive ? " is-active" : ""}`
                    }
                    onClick={() => setNavOpenedAt(null)}
                  >
                    {item.label}
                  </NavLink>
                ))}
              </div>
            </section>
          ))}
        </nav>

        <div className="admin-sidebar__footer">
          <div className="admin-platform-notice">
            <strong>Active workspace</strong>
            {session.membership.organizationName}
          </div>
        </div>
      </aside>

      <div className="admin-layout__main">
        <header className="admin-header">
          <div className="admin-header__start">
            <button
              type="button"
              className="admin-icon-button admin-sidebar-toggle"
              aria-label="Open navigation"
              onClick={() => setNavOpenedAt(location.pathname)}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="M4 7h16M4 12h16M4 17h16" />
              </svg>
            </button>
            <div className="admin-header__summary">
              <span className="admin-kicker">Field operations</span>
              <strong>Pack intelligence workspace</strong>
            </div>
          </div>
          <div className="admin-header__end">
            <div className="admin-user-pill">
              <strong>{session.operator.displayName}</strong>
              <span>
                {session.membership.role === "admin"
                  ? "Administrator"
                  : "Data operator"}
              </span>
            </div>
            <button
              type="button"
              className="admin-button admin-button-secondary admin-sign-out"
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
            <Breadcrumbs />
            <div className="admin-main__content">
              <Outlet />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
