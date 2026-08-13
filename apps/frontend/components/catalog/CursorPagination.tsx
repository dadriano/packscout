import type { RepackPageRange } from "@packscout/contracts";
import styles from "./CursorPagination.module.css";

type CursorPaginationProps = Readonly<{
  range: RepackPageRange;
  hasPrevious: boolean;
  hasNext: boolean;
  pending?: boolean;
  onPrevious: () => void;
  onNext: () => void;
}>;

export function CursorPagination({
  range,
  hasPrevious,
  hasNext,
  pending = false,
  onPrevious,
  onNext,
}: CursorPaginationProps) {
  const label = range.total === 0 ? "No results" : `${range.start}–${range.end} of ${range.total}`;
  return (
    <nav aria-label="Catalog pages" className={styles.root}>
      <p aria-live="polite" className={styles.range}>{label}</p>
      <div className={styles.actions}>
        <button disabled={!hasPrevious || pending} onClick={onPrevious} type="button">← Previous</button>
        <button disabled={!hasNext || pending} onClick={onNext} type="button">Next →</button>
      </div>
    </nav>
  );
}
