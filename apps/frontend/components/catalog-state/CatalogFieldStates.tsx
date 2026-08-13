import { CatalogImage } from "@/components/catalog/CatalogImage.client";
import {
  getPublicReasonCopy,
  type PublicMetricReason,
} from "@/lib/metric-vocabulary";
import styles from "./CatalogState.module.css";

export function UnavailableValue({
  reason,
  compact = false,
}: {
  reason: PublicMetricReason;
  compact?: boolean;
}) {
  return (
    <span
      className={styles.unavailableValue}
      data-density={compact ? "compact" : "default"}
      data-state="field-unavailable"
    >
      <strong>Unavailable</strong>
      <span>{getPublicReasonCopy(reason)}</span>
    </span>
  );
}

export function UncategorizedValue() {
  return (
    <span className={styles.uncategorizedValue}>
      <span aria-hidden="true" />
      Uncategorized
    </span>
  );
}

export function MissingRepackImage({
  repackName,
  variant = "thumbnail",
}: {
  repackName: string;
  variant?: "thumbnail" | "pack";
}) {
  return (
    <CatalogImage
      fallbackAlt={repackName}
      image={null}
      variant={variant}
    />
  );
}

export function MissingChaseMedia({
  chaseName,
  displayValue,
}: {
  chaseName: string;
  displayValue: string | null;
}) {
  return (
    <div
      aria-label={`Image unavailable for ${chaseName}`}
      className={styles.chaseTextFallback}
    >
      <span className={styles.chaseImageStatus}>Image unavailable</span>
      <strong>{chaseName}</strong>
      <span>{displayValue ?? "Top chase value unavailable."}</span>
    </div>
  );
}
