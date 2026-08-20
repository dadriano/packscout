import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";

/** Surfaces the panel owns. Later tasks fill in the stubs listed here. */
export const PANEL_NAVIGATION = [
  { to: "/logs", label: "Log sources" },
  { to: "/database", label: "Database" },
  { to: "/activity", label: "Activity" },
] as const;

export function PanelShell({ children }: { children: ReactNode }) {
  return (
    <div className="panel-layout">
      <a className="panel-skip-link" href="#panel-main">
        Skip to content
      </a>
      <header className="panel-sidebar">
        <p className="panel-brand">PackScout Operations</p>
        <p className="panel-brand-note">Local tool. Loopback only.</p>
        <nav className="panel-nav" aria-label="Panel surfaces">
          {PANEL_NAVIGATION.map((item) => (
            <NavLink key={item.to} to={item.to}>
              {item.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="panel-main" id="panel-main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}

export function PanelPageHeader({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="panel-page-header">
      <p className="panel-eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
  );
}
