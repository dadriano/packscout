import { useCallback, useEffect, useState } from "react";
import {
  boundedProductUserSubjectLabel,
  describeProductUserEstimatedEv,
  describeProductUserIdentity,
  type ProductUserDetail,
  type ProductUserSavedCollectible,
  type ProductUserSavedRepack,
  type ProductUserStandingChange,
} from "@packscout/contracts";
import { Link, useParams } from "react-router-dom";
import { AdminApiError } from "../api/client";
import { getProductUserDetail } from "../api/product-users";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import { AuthRestrictedState } from "../components/auth/AuthRestrictedState";
import { dateTime, humanize } from "../components/operations/OperationStatus";
import {
  describeDirectoryFailure,
  OPAQUE_USER_LINK_FAILURE,
  type DirectoryFailure,
} from "../components/product-users/directory-failure";
import { ProductUserStandingControl } from "../components/product-users/ProductUserStandingControl";
import {
  SavedItemCollection,
  type SavedItemRow,
} from "../components/product-users/SavedItemCollection";
import { resolveProductUserHandle } from "../components/product-users/subject-handle";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useSession } from "../providers/session";

/**
 * What one product user holds in PackScout today.
 *
 * Saved items belong to the user: they are shown so an administrator can see
 * what an account holds before acting on it, and no control here adds,
 * removes, or edits one. The single account control is the reversible standing
 * flip beside the standing badge, which never touches saved data.
 */

function repackRow(item: ProductUserSavedRepack): SavedItemRow {
  if (item.resolution === "unresolved") {
    return {
      publicId: item.publicRepackId,
      savedAt: item.savedAt,
      name: null,
      facts: [],
    };
  }
  return {
    publicId: item.publicRepackId,
    savedAt: item.savedAt,
    name: item.name,
    facts: [
      { term: "Vendor", value: item.vendorDisplayName },
      {
        term: "Availability",
        value: item.availability === "active" ? "Available now" : "Sold out",
      },
      {
        term: "Estimated value",
        value:
          item.estimatedEv === null
            ? "No current estimate"
            : describeProductUserEstimatedEv(item.estimatedEv),
      },
    ],
  };
}

function collectibleRow(item: ProductUserSavedCollectible): SavedItemRow {
  return item.resolution === "unresolved"
    ? {
        publicId: item.publicCollectibleId,
        savedAt: item.savedAt,
        name: null,
        facts: [],
      }
    : {
        publicId: item.publicCollectibleId,
        savedAt: item.savedAt,
        name: item.name,
        facts: [{ term: "Kind", value: humanize(item.collectibleType) }],
      };
}

export function ProductUserDetailPage() {
  /**
   * The route names an opaque handle, so the subject key stays out of the URL,
   * out of history, and out of access logs. It is resolved back here, in
   * memory, and travels onward only in this page's POST bodies.
   */
  const { handle = "" } = useParams();
  const subject = resolveProductUserHandle(handle);
  const { status } = useSession();
  const canManage =
    status.phase === "authenticated" &&
    status.session.permissions.includes("product_users:manage");
  const [detail, setDetail] = useState<ProductUserDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [failure, setFailure] = useState<DirectoryFailure | null>(null);
  const [refreshIndex, setRefreshIndex] = useState(0);
  const identity =
    detail === null ? null : describeProductUserIdentity(detail.user);
  useDocumentTitle(identity?.label ?? "Product user");

  /**
   * A handle this tab never issued names nobody, so nothing is read for it and
   * nothing about it can be loading. It is a property of the route, decided
   * while rendering rather than discovered by asking the server.
   */
  const opaqueLink = subject === null;

  useEffect(() => {
    if (subject === null) return;
    const controller = new AbortController();
    void getProductUserDetail(subject, controller.signal)
      .then((loaded) => {
        setDetail(loaded);
        setFailure(null);
        setForbidden(false);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setDetail(null);
        if (error instanceof AdminApiError && error.status === 403) {
          setForbidden(true);
          return;
        }
        setFailure(describeDirectoryFailure(error, "user"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [subject, refreshIndex]);

  /**
   * The standing shown is the one the backend reports afterwards, applied in
   * place. Nothing else about the account changed, and the saved-item
   * collections below are deliberately left exactly as they were.
   */
  const applyStandingChange = useCallback((change: ProductUserStandingChange) => {
    setDetail((current) =>
      current === null
        ? current
        : {
            ...current,
            user: { ...current.user, standing: change.user.standing },
          },
    );
  }, []);

  const backToUsers = (
    <Link className="admin-button admin-button-secondary" to="/users">
      Back to users
    </Link>
  );

  if (forbidden) {
    return (
      <div className="admin-page">
        <PageHeader
          eyebrow="Workspace / Users"
          title="Product user"
          description="What this account holds in PackScout today."
        />
        <AuthRestrictedState description="Your operator account is active, but it does not include permission to view product users. You can continue using the operational tools assigned to your role." />
      </div>
    );
  }

  if (loading && !opaqueLink) {
    return (
      <div className="admin-page">
        <PageHeader
          eyebrow="Workspace / Users"
          title="Product user"
          description="What this account holds in PackScout today."
          actions={backToUsers}
        />
        <section className="admin-surface admin-panel" aria-busy="true" aria-live="polite">
          <span className="admin-kicker">Loading this user…</span>
        </section>
      </div>
    );
  }

  if (detail === null || identity === null) {
    const described = opaqueLink
      ? OPAQUE_USER_LINK_FAILURE
      : (failure ?? describeDirectoryFailure(new Error("missing"), "user"));
    return (
      <div className="admin-page">
        <PageHeader
          eyebrow="Workspace / Users"
          title="Product user"
          description="What this account holds in PackScout today."
          actions={backToUsers}
        />
        <div role="alert">
          <EmptyState
            eyebrow="User unavailable"
            title={described.title}
            description={described.description}
            action={
              described.retryable ? (
                <button
                  type="button"
                  className="admin-button admin-button-secondary"
                  onClick={() => {
                    setLoading(true);
                    setRefreshIndex((value) => value + 1);
                  }}
                >
                  Try again
                </button>
              ) : (
                backToUsers
              )
            }
          />
        </div>
      </div>
    );
  }

  const { user } = detail;
  const hasUnresolved =
    detail.savedRepacks.some((item) => item.resolution === "unresolved") ||
    detail.savedCollectibles.some((item) => item.resolution === "unresolved");
  return (
    <div className="admin-page">
      <PageHeader
        eyebrow="Workspace / Users"
        title={identity.label}
        description="Everything this account holds in PackScout today, newest saves first. Saved items are read-only."
        actions={backToUsers}
      />

      <section className="admin-surface admin-panel" aria-labelledby="product-user-identity">
        <header className="admin-section-header">
          <div>
            <span className="admin-kicker">Sign-up record</span>
            <h2 id="product-user-identity">Identity and standing</h2>
          </div>
          <div className="product-users__row-actions">
            <StatusBadge
              label={user.standing === "active" ? "Active" : "Suspended"}
              tone={user.standing === "active" ? "ready" : "danger"}
            />
            {canManage ? (
              <ProductUserStandingControl
                user={user}
                onChanged={applyStandingChange}
              />
            ) : null}
          </div>
        </header>
        <dl className="product-users__facts">
          <div>
            <dt>Email</dt>
            <dd>{user.email ?? "None recorded"}</dd>
          </div>
          <div>
            <dt>Wallet address</dt>
            <dd>{user.walletAddress ?? "None recorded"}</dd>
          </div>
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
            <dt>Subject key</dt>
            <dd title={user.subject}>
              {boundedProductUserSubjectLabel(user.subject)}
            </dd>
          </div>
        </dl>
      </section>

      {detail.catalogAvailable ? null : (
        <p className="product-users__note" role="status">
          No active catalog could be read, so saved items below could not be
          resolved to catalog information. They are still listed by identifier.
        </p>
      )}

      {detail.catalogAvailable && hasUnresolved ? (
        <p className="product-users__note">
          Items no longer in the current catalog can disappear on their own:
          when this user is at the save limit for a kind, saving another item
          drops their oldest item of that kind that has left the catalog.
        </p>
      ) : null}

      <SavedItemCollection
        id="saved-repacks"
        eyebrow="Owned by this user"
        title="Saved repacks"
        rows={detail.savedRepacks.map(repackRow)}
        emptyTitle="This user has not saved any repacks."
        emptyDescription="Repacks appear here when the user saves one in PackScout."
        catalogAvailable={detail.catalogAvailable}
      />

      <SavedItemCollection
        id="saved-collectibles"
        eyebrow="Owned by this user"
        title="Saved collectibles"
        rows={detail.savedCollectibles.map(collectibleRow)}
        emptyTitle="This user has not saved any collectibles."
        emptyDescription="Collectibles appear here when the user saves one in PackScout."
        catalogAvailable={detail.catalogAvailable}
      />
    </div>
  );
}
