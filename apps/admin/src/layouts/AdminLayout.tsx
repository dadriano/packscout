import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useTheme } from "../hooks/useTheme";

const navigation = [
  {
    title: "Workspace",
    items: [{ to: "/", label: "Overview", index: "01" }],
  },
];

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
  const { resolvedTheme, setTheme } = useTheme();
  const [navOpenedAt, setNavOpenedAt] = useState<string | null>(null);
  const navOpen = navOpenedAt === location.pathname;
  useDocumentTitle(location.pathname === "/" ? "Overview" : "Not found");

  useEffect(() => {
    if (!navOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setNavOpenedAt(null);
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [navOpen]);

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
              <strong>Packscout</strong>
              <small>Operations console</small>
            </span>
          </NavLink>
          <button
            type="button"
            className="admin-icon-button admin-sidebar__close"
            aria-label="Close navigation"
            onClick={() => setNavOpenedAt(null)}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>

        <nav className="admin-sidebar__nav">
          {navigation.map((section) => (
            <section key={section.title} className="admin-nav-section">
              <h2>{section.title}</h2>
              {section.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end
                  className={({ isActive }) =>
                    `admin-nav-link${isActive ? " is-active" : ""}`
                  }
                  onClick={() => setNavOpenedAt(null)}
                >
                  <span aria-hidden="true">{item.index}</span>
                  {item.label}
                </NavLink>
              ))}
            </section>
          ))}
        </nav>

        <div className="admin-sidebar__footer">
          <span className="admin-eyebrow">Foundation state</span>
          <p>
            Authentication and persistence stay unclaimed until their contracts are
            selected and tested.
          </p>
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
            <span className="admin-access-note">Access controls pending</span>
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
