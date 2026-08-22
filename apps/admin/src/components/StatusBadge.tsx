export type StatusTone = "ready" | "pending" | "danger" | "neutral";

interface StatusBadgeProps {
  label: string;
  tone?: StatusTone;
}

/** Operational tones map onto the shared pill palette. */
const TONE_VARIANTS: Record<StatusTone, string> = {
  ready: "admin-pill-success",
  pending: "admin-pill-warning",
  danger: "admin-pill-danger",
  neutral: "admin-pill-neutral",
};

export function StatusBadge({ label, tone = "neutral" }: StatusBadgeProps) {
  return (
    <span className={`admin-pill ${TONE_VARIANTS[tone]}`}>
      <span aria-hidden="true" />
      {label}
    </span>
  );
}
