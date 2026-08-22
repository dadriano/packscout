import { useState } from "react";
import { EmptyState } from "../EmptyState";
import { dateTime } from "../operations/OperationStatus";

/**
 * How many rows render before an administrator asks for the rest. A user may
 * hold up to the product's per-kind save cap, and a page that lays out every
 * one of those rows up front is slow to read and slow to paint.
 */
const INITIAL_ROWS = 25;

export interface SavedItemFact {
  readonly term: string;
  readonly value: string;
}

export interface SavedItemRow {
  /** The stable public identifier; always shown, resolved or not. */
  readonly publicId: string;
  readonly savedAt: string;
  /** The catalog display name, or null when the reference did not resolve. */
  readonly name: string | null;
  readonly facts: readonly SavedItemFact[];
}

interface SavedItemCollectionProps {
  /** Distinguishes this collection's headings and controls on the page. */
  readonly id: string;
  readonly eyebrow: string;
  readonly title: string;
  readonly rows: readonly SavedItemRow[];
  readonly emptyTitle: string;
  readonly emptyDescription: string;
  /** False when no active catalog could be read, so nothing could resolve. */
  readonly catalogAvailable: boolean;
}

/**
 * One saved-item collection, newest save first, exactly as the product
 * backend resolved it. The view is read-only: there is no control here that
 * adds, removes, or edits a user's saved items.
 */
export function SavedItemCollection({
  id,
  eyebrow,
  title,
  rows,
  emptyTitle,
  emptyDescription,
  catalogAvailable,
}: SavedItemCollectionProps) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? rows : rows.slice(0, INITIAL_ROWS);
  const hidden = rows.length - visible.length;

  return (
    <section className="admin-ledger" aria-labelledby={`${id}-title`}>
      <header className="admin-section-heading">
        <div>
          <span className="admin-eyebrow">{eyebrow}</span>
          <h2 id={`${id}-title`}>{title}</h2>
        </div>
        <span className="admin-section-count">
          {rows.length} saved
        </span>
      </header>

      {rows.length === 0 ? (
        <EmptyState
          eyebrow="Nothing saved"
          title={emptyTitle}
          description={emptyDescription}
        />
      ) : (
        <>
          <ol className="saved-items__rows">
            {visible.map((row) => (
              <li key={row.publicId}>
                <div className="saved-items__heading">
                  {row.name === null ? (
                    <strong className="saved-items__unresolved">
                      {catalogAvailable
                        ? "No longer in the current catalog"
                        : "Not resolved: the active catalog could not be read"}
                    </strong>
                  ) : (
                    <strong title={row.name}>{row.name}</strong>
                  )}
                  <time dateTime={row.savedAt}>Saved {dateTime(row.savedAt)}</time>
                </div>
                <dl className="product-users__facts">
                  {row.facts.map((fact) => (
                    <div key={fact.term}>
                      <dt>{fact.term}</dt>
                      <dd>{fact.value}</dd>
                    </div>
                  ))}
                  <div>
                    <dt>Identifier</dt>
                    <dd className="saved-items__identifier">{row.publicId}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ol>
          {hidden > 0 ? (
            <button
              type="button"
              className="admin-button admin-button--secondary"
              onClick={() => setExpanded(true)}
            >
              {`Show all ${rows.length}`}
            </button>
          ) : null}
          <p className="saved-items__count" role="status">
            {`Showing ${visible.length} of ${rows.length}.`}
          </p>
        </>
      )}
    </section>
  );
}
