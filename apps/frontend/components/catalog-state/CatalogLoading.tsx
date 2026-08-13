import styles from "./CatalogState.module.css";
import { CATALOG_STATE_COPY } from "./catalog-state";

export type StablePlaceholderVariant =
  | "kpi"
  | "row"
  | "summary"
  | "image"
  | "inspector";

function SkeletonBlock({ className = "" }: { className?: string }) {
  return <span className={`${styles.skeletonBlock} ${className}`} />;
}

export function StablePlaceholder({
  variant,
}: {
  variant: StablePlaceholderVariant;
}) {
  if (variant === "kpi") {
    return (
      <div aria-hidden="true" className={styles.kpiPlaceholder}>
        <SkeletonBlock className={styles.square} />
        <span className={styles.placeholderCopy}>
          <SkeletonBlock className={styles.metricLine} />
          <SkeletonBlock className={styles.labelLine} />
        </span>
      </div>
    );
  }

  if (variant === "row") {
    return (
      <div aria-hidden="true" className={styles.rowPlaceholder}>
        <SkeletonBlock className={styles.thumbnail} />
        <SkeletonBlock className={styles.rowPrimary} />
        <SkeletonBlock className={styles.rowSecondary} />
        <SkeletonBlock className={styles.rowMetric} />
        <SkeletonBlock className={styles.rowMetric} />
      </div>
    );
  }

  if (variant === "summary") {
    return (
      <div aria-hidden="true" className={styles.summaryPlaceholder}>
        <SkeletonBlock className={styles.summaryLabel} />
        <SkeletonBlock className={styles.summaryBar} />
        <SkeletonBlock className={styles.summaryValue} />
      </div>
    );
  }

  if (variant === "image") {
    return (
      <div aria-hidden="true" className={styles.imagePlaceholder}>
        <SkeletonBlock className={styles.imageBlock} />
        <SkeletonBlock className={styles.imageLabel} />
      </div>
    );
  }

  return (
    <div aria-hidden="true" className={styles.inspectorPlaceholder}>
      <StablePlaceholder variant="image" />
      <span className={styles.inspectorCopy}>
        <SkeletonBlock className={styles.inspectorTitle} />
        <SkeletonBlock className={styles.inspectorMeta} />
        <SkeletonBlock className={styles.inspectorPrice} />
      </span>
      <SkeletonBlock className={styles.inspectorRule} />
      <SkeletonBlock className={styles.inspectorChart} />
    </div>
  );
}

export function CatalogLoading({
  surface = "overview",
}: {
  surface?: "overview" | "all-repacks";
}) {
  return (
    <section
      aria-busy="true"
      aria-labelledby="catalog-loading-status"
      className={styles.loadingRoot}
      data-surface={surface}
    >
      <p
        aria-live="polite"
        className={styles.visuallyHidden}
        id="catalog-loading-status"
        role="status"
      >
        {CATALOG_STATE_COPY.loading}
      </p>

      <div aria-hidden="true" className={styles.loadingKpis}>
        {Array.from({ length: 4 }, (_, index) => (
          <StablePlaceholder key={index} variant="kpi" />
        ))}
      </div>

      <div aria-hidden="true" className={styles.loadingFilters}>
        <SkeletonBlock className={styles.filterField} />
        <SkeletonBlock className={styles.filterField} />
        <SkeletonBlock className={styles.filterField} />
        <SkeletonBlock className={styles.filterAction} />
      </div>

      <div className={styles.loadingContent}>
        <div className={styles.loadingResults}>
          {Array.from({ length: surface === "overview" ? 6 : 8 }, (_, index) => (
            <StablePlaceholder key={index} variant="row" />
          ))}
        </div>
        <StablePlaceholder variant="inspector" />
      </div>

      <div aria-hidden="true" className={styles.loadingSummaries}>
        <div className={styles.summaryGroup}>
          {Array.from({ length: 2 }, (_, index) => (
            <StablePlaceholder key={index} variant="summary" />
          ))}
        </div>
        <div className={styles.summaryGroup}>
          {Array.from({ length: 3 }, (_, index) => (
            <StablePlaceholder key={index} variant="summary" />
          ))}
        </div>
      </div>
    </section>
  );
}
