interface KeysetPaginationProps {
  page: number;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
}

export function KeysetPagination({
  page,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
}: KeysetPaginationProps) {
  if (!hasPrevious && !hasNext) return null;
  return (
    <nav className="ops-pagination" aria-label="Results pages">
      <button type="button" className="admin-button admin-button--secondary" disabled={!hasPrevious} onClick={onPrevious}>Previous</button>
      <span aria-live="polite">Page {page}</span>
      <button type="button" className="admin-button admin-button--secondary" disabled={!hasNext} onClick={onNext}>Next</button>
    </nav>
  );
}
