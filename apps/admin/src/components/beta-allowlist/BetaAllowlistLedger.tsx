import type { BetaAllowlistRow } from "@packscout/contracts";
import { dateTime } from "../operations/OperationStatus";

interface BetaAllowlistLedgerProps {
  entries: readonly BetaAllowlistRow[];
  /** Ledger position of the first row on this page, one-based. */
  startIndex: number;
  /**
   * Edit and remove appear only for operators holding the manage permission.
   * Everyone else sees the entries and no way to change them.
   */
  canManage: boolean;
  onEdit: (entry: BetaAllowlistRow) => void;
  onRemove: (entry: BetaAllowlistRow) => void;
}

/**
 * The invitation ledger: who has been let into the closed beta in advance,
 * newest change first. Rows are keyed on the entry id — an opaque backend
 * value — and the identifiers themselves render only as page content. No row
 * links anywhere: an allowlist entry has no detail view, so no URL ever needs
 * to exist for it, and none does.
 */
export function BetaAllowlistLedger({
  entries,
  startIndex,
  canManage,
  onEdit,
  onRemove,
}: BetaAllowlistLedgerProps) {
  return (
    <section className="admin-surface admin-panel" aria-labelledby="beta-allowlist-ledger-title">
      <header className="admin-section-header">
        <div>
          <span className="admin-kicker">Invitation ledger</span>
          <h2 id="beta-allowlist-ledger-title">Allowlist entries</h2>
        </div>
        <span className="admin-section-count">
          {String(entries.length).padStart(2, "0")} on page
        </span>
      </header>
      <div className="admin-row-list">
        {entries.map((entry, index) => {
          // An entry names an email address, a wallet address, or both; the
          // first present identifier leads the row and the other follows.
          const primary = entry.email ?? entry.walletAddress ?? "";
          const secondary = entry.email !== null ? entry.walletAddress : null;
          return (
            <article key={entry.entryId}>
              <span>{String(startIndex + index).padStart(2, "0")}</span>
              <div>
                <strong className="beta-allowlist__identifier" title={primary}>
                  {primary}
                </strong>
                {secondary !== null ? (
                  <p className="beta-allowlist__identifier-secondary">
                    {secondary}
                  </p>
                ) : null}
                <dl className="beta-allowlist__facts">
                  <div>
                    <dt>Label</dt>
                    <dd>{entry.label ?? "No label"}</dd>
                  </div>
                  <div>
                    <dt>Added</dt>
                    <dd>{dateTime(entry.createdAt)}</dd>
                  </div>
                  <div>
                    <dt>Added by</dt>
                    <dd>
                      {entry.createdByDisplayName ?? (
                        <span
                          className="beta-allowlist__operator-reference"
                          title="This operator account is no longer listed in the workspace."
                        >
                          {entry.createdByOperatorId}
                        </span>
                      )}
                    </dd>
                  </div>
                  {entry.updatedAt !== entry.createdAt ? (
                    <div>
                      <dt>Updated</dt>
                      <dd>{dateTime(entry.updatedAt)}</dd>
                    </div>
                  ) : null}
                </dl>
              </div>
              {canManage ? (
                <div className="beta-allowlist__row-actions">
                  <button
                    type="button"
                    className="admin-button admin-button-secondary"
                    onClick={() => onEdit(entry)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="admin-button admin-button-danger"
                    onClick={() => onRemove(entry)}
                  >
                    Remove
                  </button>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
