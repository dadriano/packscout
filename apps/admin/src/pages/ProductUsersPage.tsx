import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  formatProductUserAwaitingCount,
  type ProductUserAccessDecisionChange,
  type ProductUserAccessQueueCount,
  type ProductUserDirectoryRow,
  type ProductUserStandingChange,
} from "@packscout/contracts";
import { AdminApiError } from "../api/client";
import {
  getProductUserAccessQueueCount,
  listProductUserAccessQueue,
  listProductUsers,
} from "../api/product-users";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import { AuthRestrictedState } from "../components/auth/AuthRestrictedState";
import { KeysetPagination } from "../components/operations/KeysetPagination";
import {
  describeDirectoryFailure,
  type DirectoryFailure,
} from "../components/product-users/directory-failure";
import { ProductUserLedger } from "../components/product-users/ProductUserLedger";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useSession } from "../providers/session";

const PAGE_SIZE = 20;

/**
 * The users area has two parallel views over the same directory: the full
 * sign-up ledger, most recent activity first, and the review queue — the
 * identities awaiting a beta-access decision, oldest request first so nobody
 * is buried. The waiting count sits in the page header, visible from either
 * view without paging the queue.
 */
type UsersView = "directory" | "queue";

export function ProductUsersPage() {
  useDocumentTitle("Users");
  const { status } = useSession();
  const canManage =
    status.phase === "authenticated" &&
    status.session.permissions.includes("product_users:manage");
  const [view, setView] = useState<UsersView>("directory");
  const [users, setUsers] = useState<ProductUserDirectoryRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([]);
  const [searchDraft, setSearchDraft] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [queueTruncated, setQueueTruncated] = useState(false);
  const [awaiting, setAwaiting] = useState<ProductUserAccessQueueCount | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [failure, setFailure] = useState<DirectoryFailure | null>(null);
  const [refreshIndex, setRefreshIndex] = useState(0);
  const [countRefreshIndex, setCountRefreshIndex] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const load =
      view === "queue"
        ? listProductUserAccessQueue(
            { ...(cursor ? { cursor } : {}), limit: PAGE_SIZE },
            controller.signal,
          ).then((page) => {
            setUsers([...page.items]);
            setNextCursor(page.nextCursor);
            setQueueTruncated(page.queueTruncated);
          })
        : listProductUsers(
            {
              ...(appliedSearch ? { search: appliedSearch } : {}),
              ...(cursor ? { cursor } : {}),
              limit: PAGE_SIZE,
            },
            controller.signal,
          ).then((page) => {
            setUsers([...page.items]);
            setNextCursor(page.nextCursor);
            setSearchTruncated(page.searchTruncated);
          });
    void load
      .then(() => {
        setFailure(null);
        setForbidden(false);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (error instanceof AdminApiError && error.status === 403) {
          setForbidden(true);
          setUsers([]);
          return;
        }
        setUsers([]);
        setFailure(describeDirectoryFailure(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [view, appliedSearch, cursor, refreshIndex]);

  /**
   * The waiting count for the header. It is presence information, not the
   * queue itself: when it cannot be read the header simply shows no count
   * while the main view reports the failure, so the number never lies.
   */
  useEffect(() => {
    const controller = new AbortController();
    void getProductUserAccessQueueCount(controller.signal)
      .then(setAwaiting)
      .catch(() => {
        if (!controller.signal.aborted) setAwaiting(null);
      });
    return () => controller.abort();
  }, [countRefreshIndex]);

  /**
   * The ledger reflects the standing the backend reports, immediately and in
   * place. The whole page is not reloaded: a listing reload would move rows
   * under the administrator who just acted, and the row they acted on is the
   * one thing that certainly changed.
   */
  const applyStandingChange = useCallback((change: ProductUserStandingChange) => {
    setUsers((rows) =>
      rows.map((row) =>
        row.subject === change.user.subject
          ? { ...row, standing: change.user.standing }
          : row,
      ),
    );
  }, []);

  /**
   * A decision updates its row in place with the decision the backend now
   * holds — in the queue view too, where the decided row keeps its place with
   * its new state and controls until the operator moves on, rather than rows
   * shifting under the person working the queue. The header count is
   * re-read, since the queue just changed size.
   */
  const applyAccessDecision = useCallback(
    (subject: string, change: ProductUserAccessDecisionChange) => {
      setUsers((rows) =>
        rows.map((row) =>
          row.subject === subject ? { ...row, access: change.access } : row,
        ),
      );
      setCountRefreshIndex((value) => value + 1);
    },
    [],
  );

  function restart(search: string) {
    setCursor(undefined);
    setCursorStack([]);
    setAppliedSearch(search);
    setLoading(true);
    setRefreshIndex((value) => value + 1);
  }

  function applySearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    restart(searchDraft.trim());
  }

  function switchView(next: UsersView) {
    if (next === view) return;
    setView(next);
    setCursor(undefined);
    setCursorStack([]);
    setUsers([]);
    setLoading(true);
  }

  const awaitingLabel =
    awaiting === null ? null : formatProductUserAwaitingCount(awaiting);
  const headerCount =
    awaitingLabel === null ? undefined : (
      <span role="status">
        <StatusBadge
          label={`${awaitingLabel} awaiting review`}
          tone={awaiting !== null && awaiting.count > 0 ? "pending" : "neutral"}
        />
      </span>
    );

  if (forbidden) {
    return (
      <div className="admin-page">
        <PageHeader
          eyebrow="Workspace / Users"
          title="Product users"
          description="Everyone who has signed up for PackScout, most recent activity first."
        />
        <AuthRestrictedState description="Your operator account is active, but it does not include permission to view product users. You can continue using the operational tools assigned to your role." />
      </div>
    );
  }

  const searching = appliedSearch.length > 0;
  const inQueue = view === "queue";
  return (
    <div className="admin-page">
      <PageHeader
        eyebrow="Workspace / Users"
        title="Product users"
        description={
          inQueue
            ? "Identities waiting for a beta-access decision, oldest request first, with how they signed in and when they arrived."
            : "Everyone who has signed up for PackScout, most recent activity first, with how they signed in, their standing, their beta access, and how much they have saved."
        }
        actions={headerCount}
      />

      <div
        className="product-users__views"
        role="group"
        aria-label="Product user views"
      >
        <button
          type="button"
          className={`admin-button admin-button-secondary${inQueue ? "" : " is-active"}`}
          aria-pressed={!inQueue}
          onClick={() => switchView("directory")}
        >
          All users
        </button>
        <button
          type="button"
          className={`admin-button admin-button-secondary${inQueue ? " is-active" : ""}`}
          aria-pressed={inQueue}
          onClick={() => switchView("queue")}
        >
          {awaitingLabel === null
            ? "Review queue"
            : `Review queue (${awaitingLabel})`}
        </button>
      </div>

      {inQueue ? null : (
        <form
          className="admin-surface admin-panel"
          aria-label="Search product users"
          onSubmit={applySearch}
        >
          <div className="admin-section-header">
            <div className="admin-field product-users__search">
              <label htmlFor="product-user-search">
                Search email, wallet address, or subject key
              </label>
              <input
                id="product-user-search"
                type="search"
                autoComplete="off"
                value={searchDraft}
                onChange={(event) => setSearchDraft(event.target.value)}
              />
            </div>
            <button className="admin-button admin-button-secondary" type="submit">
              Search
            </button>
            {searching ? (
              <button
                type="button"
                className="admin-button admin-button-secondary"
                onClick={() => {
                  setSearchDraft("");
                  restart("");
                }}
              >
                Clear search
              </button>
            ) : null}
          </div>
        </form>
      )}

      {loading ? (
        <section className="admin-surface admin-panel" aria-busy="true" aria-live="polite">
          <span className="admin-kicker">
            {inQueue ? "Loading the review queue…" : "Loading the user directory…"}
          </span>
        </section>
      ) : failure ? (
        <div role="alert">
          <EmptyState
            eyebrow={inQueue ? "Queue unavailable" : "Directory unavailable"}
            title={failure.title}
            description={failure.description}
            action={
              <button
                type="button"
                className="admin-button admin-button-secondary"
                onClick={() => {
                  setLoading(true);
                  if (failure.retryable) {
                    setRefreshIndex((value) => value + 1);
                  } else {
                    restart(appliedSearch);
                  }
                }}
              >
                {failure.retryable ? "Try again" : "Return to the first page"}
              </button>
            }
          />
        </div>
      ) : users.length === 0 ? (
        inQueue ? (
          <EmptyState
            eyebrow="Review queue"
            title="No one is waiting for a decision."
            description="New sign-ups that are not admitted by the allowlist appear here, oldest first, until an operator approves or declines them."
          />
        ) : (
          <EmptyState
            eyebrow={searching ? "No match" : "Sign-up ledger"}
            title={
              searching
                ? "No users match this search."
                : "No users have signed up yet."
            }
            description={
              searching
                ? "Search matches the start of an email address, a wallet address, or a subject key. Clear the search to see every sign-up."
                : "A user appears here the first time they sign in to PackScout."
            }
            action={
              searching ? (
                <button
                  type="button"
                  className="admin-button admin-button-secondary"
                  onClick={() => {
                    setSearchDraft("");
                    restart("");
                  }}
                >
                  Clear search
                </button>
              ) : undefined
            }
          />
        )
      ) : (
        <ProductUserLedger
          users={users}
          startIndex={cursorStack.length * PAGE_SIZE + 1}
          canManage={canManage}
          onStandingChange={applyStandingChange}
          onAccessDecision={applyAccessDecision}
          eyebrow={inQueue ? "Review queue" : "Sign-up ledger"}
          title={inQueue ? "Awaiting a decision" : "Product users"}
        />
      )}

      {!loading && !failure && !inQueue && searchTruncated ? (
        <p className="product-users__note" role="status">
          This search reached the directory's match limit. Narrow the search to
          be certain you are seeing every match.
        </p>
      ) : null}

      {!loading && !failure && inQueue && queueTruncated ? (
        <p className="product-users__note" role="status">
          The queue is longer than this bounded view can show. It is complete
          from the front — work it oldest-first and newer arrivals will appear
          as earlier ones are decided.
        </p>
      ) : null}

      {!loading && !failure ? (
        <KeysetPagination
          page={cursorStack.length + 1}
          hasPrevious={cursorStack.length > 0}
          hasNext={Boolean(nextCursor)}
          onPrevious={() => {
            const previous = cursorStack.at(-1);
            setCursorStack((values) => values.slice(0, -1));
            setLoading(true);
            setCursor(previous);
          }}
          onNext={() => {
            if (!nextCursor) return;
            setCursorStack((values) => [...values, cursor]);
            setLoading(true);
            setCursor(nextCursor);
          }}
        />
      ) : null}
    </div>
  );
}
