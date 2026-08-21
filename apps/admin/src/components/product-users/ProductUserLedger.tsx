import {
  boundedProductUserSubjectLabel,
  describeProductUserIdentity,
  type ProductUserDirectoryRow,
  type ProductUserStandingChange,
} from "@packscout/contracts";
import { Link } from "react-router-dom";
import { StatusBadge } from "../StatusBadge";
import { dateTime } from "../operations/OperationStatus";
import { ProductUserStandingControl } from "./ProductUserStandingControl";

interface ProductUserLedgerProps {
  users: ProductUserDirectoryRow[];
  /** Ledger position of the first row on this page, one-based. */
  startIndex: number;
  /**
   * The account control appears only for operators holding the manage
   * permission. Everyone else sees the standing and no way to change it.
   */
  canManage: boolean;
  onStandingChange: (change: ProductUserStandingChange) => void;
}

function saved(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Rows are keyed on the subject — the stable identity the product backend
 * assigns — so a user with no email and no wallet address is still a complete,
 * addressable row that opens its own detail view.
 */
export function ProductUserLedger({
  users,
  startIndex,
  canManage,
  onStandingChange,
}: ProductUserLedgerProps) {
  return (
    <section className="admin-ledger" aria-labelledby="product-users-ledger-title">
      <header className="admin-section-heading">
        <div>
          <span className="admin-eyebrow">Sign-up ledger</span>
          <h2 id="product-users-ledger-title">Product users</h2>
        </div>
        <span className="admin-section-count">
          {String(users.length).padStart(2, "0")} on page
        </span>
      </header>
      <div className="admin-ledger__rows">
        {users.map((user, index) => {
          const identity = describeProductUserIdentity(user);
          const secondaryLine =
            identity.secondary ??
            (identity.kind === "subject"
              ? "No email or wallet address recorded for this sign-up."
              : null);
          return (
            <article key={user.subject} data-subject={user.subject}>
              <span>{String(startIndex + index).padStart(2, "0")}</span>
              <div>
                <Link
                  className="product-users__label"
                  to={`/users/${encodeURIComponent(user.subject)}`}
                  title={identity.label}
                >
                  {identity.label}
                </Link>
                {secondaryLine ? (
                  <p className="product-users__identity">{secondaryLine}</p>
                ) : null}
                <dl className="product-users__facts">
                  <div>
                    <dt>Sign-in source</dt>
                    <dd>{user.authMethod}</dd>
                  </div>
                  <div>
                    <dt>First seen</dt>
                    <dd>{dateTime(user.firstSeenAt)}</dd>
                  </div>
                  <div>
                    <dt>Last seen</dt>
                    <dd>{dateTime(user.lastSeenAt)}</dd>
                  </div>
                  <div>
                    <dt>Saved</dt>
                    <dd>
                      {saved(user.savedRepackCount, "repack")} ·{" "}
                      {saved(user.savedCollectibleCount, "collectible")}
                    </dd>
                  </div>
                  <div>
                    <dt>Subject key</dt>
                    <dd title={user.subject}>
                      {boundedProductUserSubjectLabel(user.subject)}
                    </dd>
                  </div>
                </dl>
              </div>
              <div className="product-users__row-actions">
                <StatusBadge
                  label={user.standing === "active" ? "Active" : "Suspended"}
                  tone={user.standing === "active" ? "ready" : "danger"}
                />
                {canManage ? (
                  <ProductUserStandingControl
                    user={user}
                    onChanged={onStandingChange}
                  />
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
