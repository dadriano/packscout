import type { ReactNode } from "react";

interface EmptyStateProps {
  eyebrow?: string;
  title: string;
  description: string;
  action?: ReactNode;
}

export function EmptyState({
  eyebrow = "Clear trail",
  title,
  description,
  action,
}: EmptyStateProps) {
  return (
    <section className="admin-surface admin-empty-state">
      <span className="admin-kicker">{eyebrow}</span>
      <h2>{title}</h2>
      <p>{description}</p>
      {action ? <div className="admin-empty-state__action">{action}</div> : null}
    </section>
  );
}
