import {
  boundedProductUserSubjectLabel,
  describeProductUserIdentity,
  type ProductUserAccessDecisionChange,
  type ProductUserDirectoryRow,
  type ProductUserStandingChange,
} from "@packscout/contracts";
import { Link } from "react-router-dom";
import { StatusBadge } from "../StatusBadge";
import { dateTime } from "../operations/OperationStatus";
import {
  ProductUserAccessBadge,
  ProductUserAccessControl,
  productUserAccessProvenanceLine,
} from "./ProductUserAccessControl";
import { ProductUserStandingControl } from "./ProductUserStandingControl";
import { productUserHandle } from "./subject-handle";

interface ProductUserLedgerProps {
  users: ProductUserDirectoryRow[];
  /** Ledger position of the first row on this page, one-based. */
  startIndex: number;
  /**
   * The account controls appear only for operators holding the manage
   * permission. Everyone else sees the standing and access state and no way
   * to change either.
   */
  canManage: boolean;
  onStandingChange: (change: ProductUserStandingChange) => void;
  onAccessDecision: (
    subject: string,
    change: ProductUserAccessDecisionChange,
  ) => void;
  /** The section heading, so the queue view names itself as the queue. */
  eyebrow?: string;
  title?: string;
}

function saved(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Rows are keyed on the subject — the stable identity the product backend
 * assigns — so a user with no email and no wallet address is still a complete,
 * addressable row that opens its own detail view.
 *
 * The row's link carries an opaque handle rather than that subject: the subject
 * is personal data and a URL is written down in history, logs, and referrers.
 * The subject continues to travel only in the POST bodies the detail view and
 * the account controls send.
 *
 * Each row shows both account dimensions side by side: standing (was this
 * account disciplined) and access (was this person let into the beta), each
 * with its own badge, so a waiting account can never be mistaken for a
 * suspended one.
 */
export function ProductUserLedger({
  users,
  startIndex,
  canManage,
  onStandingChange,
  onAccessDecision,
  eyebrow = "Sign-up ledger",
  title = "Product users",
}: ProductUserLedgerProps) {
  return (
    <section className="admin-ledger" aria-labelledby="product-users-ledger-title">
      <header className="admin-section-heading">
        <div>
          <span className="admin-eyebrow">{eyebrow}</span>
          <h2 id="product-users-ledger-title">{title}</h2>
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
            <article key={user.subject}>
              <span>{String(startIndex + index).padStart(2, "0")}</span>
              <div>
                <Link
                  className="product-users__label"
                  to={`/users/${productUserHandle(user.subject)}`}
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
                    <dt>Beta access</dt>
                    <dd>{productUserAccessProvenanceLine(user.access)}</dd>
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
                <ProductUserAccessBadge state={user.access.state} />
                <StatusBadge
                  label={user.standing === "active" ? "Active" : "Suspended"}
                  tone={user.standing === "active" ? "ready" : "danger"}
                />
                {canManage ? (
                  <>
                    <ProductUserAccessControl
                      user={user}
                      onDecided={onAccessDecision}
                    />
                    <ProductUserStandingControl
                      user={user}
                      onChanged={onStandingChange}
                    />
                  </>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
