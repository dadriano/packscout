import { useEffect, useState, type FormEvent } from "react";
import type { ProductUserDirectoryRow } from "@packscout/contracts";
import { AdminApiError } from "../api/client";
import { listProductUsers } from "../api/product-users";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { AuthRestrictedState } from "../components/auth/AuthRestrictedState";
import { KeysetPagination } from "../components/operations/KeysetPagination";
import { ProductUserLedger } from "../components/product-users/ProductUserLedger";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

const PAGE_SIZE = 20;

interface DirectoryFailure {
  readonly title: string;
  readonly description: string;
  /** False when retrying the same request cannot help. */
  readonly retryable: boolean;
}

/**
 * Failure copy derived from the admin's own stable codes. The product-backend
 * integration never reports a raw upstream error, so there is nothing here to
 * restate beyond what the admin service already decided to say.
 */
function describeFailure(error: unknown): DirectoryFailure {
  if (error instanceof AdminApiError) {
    if (error.code === "PRODUCT_USER_DIRECTORY_UNCONFIGURED") {
      return {
        title: "The product-user directory is not connected.",
        description:
          "This admin service has no configured connection to the product backend, so sign-ups cannot be listed. Nothing has been changed; configure the integration on the server and reload.",
        retryable: false,
      };
    }
    if (error.code === "INVALID_PRODUCT_USER_CURSOR") {
      return {
        title: "This page of the directory is no longer valid.",
        description:
          "The directory moved on while you were paging through it. Return to the first page to continue.",
        retryable: false,
      };
    }
    if (error.status === 429) {
      return {
        title: "Too many directory requests.",
        description: "Wait a moment before searching or paging again.",
        retryable: true,
      };
    }
    return {
      title: "The product-user directory could not be loaded.",
      description: `${error.message} Nothing has been changed.`,
      retryable: true,
    };
  }
  return {
    title: "The product-user directory could not be loaded.",
    description:
      "PackScout Admin is temporarily unavailable. Nothing has been changed.",
    retryable: true,
  };
}

export function ProductUsersPage() {
  useDocumentTitle("Users");
  const [users, setUsers] = useState<ProductUserDirectoryRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([]);
  const [searchDraft, setSearchDraft] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [failure, setFailure] = useState<DirectoryFailure | null>(null);
  const [refreshIndex, setRefreshIndex] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void listProductUsers(
      {
        ...(appliedSearch ? { search: appliedSearch } : {}),
        ...(cursor ? { cursor } : {}),
        limit: PAGE_SIZE,
      },
      controller.signal,
    )
      .then((page) => {
        setUsers([...page.items]);
        setNextCursor(page.nextCursor);
        setSearchTruncated(page.searchTruncated);
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
        setFailure(describeFailure(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [appliedSearch, cursor, refreshIndex]);

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
  return (
    <div className="admin-page">
      <PageHeader
        eyebrow="Workspace / Users"
        title="Product users"
        description="Everyone who has signed up for PackScout, most recent activity first, with how they signed in, their standing, and how much they have saved."
      />

      <form
        className="admin-ledger"
        aria-label="Search product users"
        onSubmit={applySearch}
      >
        <div className="admin-section-heading">
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
          <button className="admin-button admin-button--secondary" type="submit">
            Search
          </button>
          {searching ? (
            <button
              type="button"
              className="admin-button admin-button--secondary"
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

      {loading ? (
        <section className="admin-ledger" aria-busy="true" aria-live="polite">
          <span className="admin-eyebrow">Loading the user directory…</span>
        </section>
      ) : failure ? (
        <div role="alert">
          <EmptyState
            eyebrow="Directory unavailable"
            title={failure.title}
            description={failure.description}
            action={
              <button
                type="button"
                className="admin-button admin-button--secondary"
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
                className="admin-button admin-button--secondary"
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
      ) : (
        <ProductUserLedger
          users={users}
          startIndex={cursorStack.length * PAGE_SIZE + 1}
        />
      )}

      {!loading && !failure && searchTruncated ? (
        <p className="product-users__note" role="status">
          This search reached the directory's match limit. Narrow the search to
          be certain you are seeing every match.
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
