export type StatusTone = "ready" | "pending" | "danger" | "neutral";

interface StatusBadgeProps {
  label: string;
  tone?: StatusTone;
}

export function StatusBadge({ label, tone = "neutral" }: StatusBadgeProps) {
  return (
    <span className={`admin-status admin-status--${tone}`}>
      <span aria-hidden="true" />
      {label}
    </span>
  );
}
