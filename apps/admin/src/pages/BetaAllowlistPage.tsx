import { useEffect, useState, type FormEvent } from "react";
import type { BetaAllowlistRow } from "@packscout/contracts";
import { AdminApiError } from "../api/client";
import {
  createBetaAllowlistEntry,
  listBetaAllowlist,
  removeBetaAllowlistEntry,
  updateBetaAllowlistEntry,
} from "../api/beta-allowlist";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { AuthRestrictedState } from "../components/auth/AuthRestrictedState";
import { KeysetPagination } from "../components/operations/KeysetPagination";
import {
  BetaAllowlistEntryDialog,
  type BetaAllowlistEntryFields,
} from "../components/beta-allowlist/BetaAllowlistEntryDialog";
import { BetaAllowlistLedger } from "../components/beta-allowlist/BetaAllowlistLedger";
import {
  describeAllowlistActionError,
  describeAllowlistChangeOutcome,
  describeAllowlistFailure,
  type AllowlistFailure,
} from "../components/beta-allowlist/allowlist-messages";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useConfirm } from "../providers/confirm";
import { useSession } from "../providers/session";
import { useToast } from "../providers/toast";

const PAGE_SIZE = 20;

type DialogState =
  | { readonly kind: "add" }
  | { readonly kind: "edit"; readonly entry: BetaAllowlistRow };

/**
 * The everyday tool for letting people into the closed beta before they
 * arrive: a searchable ledger of allowlisted email and wallet addresses with
 * inline add, edit, and remove, gated to administrators.
 *
 * Two allowlist semantics are surfaced here rather than left implicit,
 * because operators reason about them wrongly otherwise: adding an entry
 * admits anyone already waiting (the success toast reports how many), and
 * removing an entry never evicts anyone already admitted (the removal
 * confirmation says so before the operator commits).
 */
export function BetaAllowlistPage() {
  useDocumentTitle("Allowlist");
  const { status } = useSession();
  const { confirm } = useConfirm();
  const { showToast } = useToast();
  const canManage =
    status.phase === "authenticated" &&
    status.session.permissions.includes("beta_allowlist:manage");
  const [entries, setEntries] = useState<BetaAllowlistRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([]);
  const [searchDraft, setSearchDraft] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [failure, setFailure] = useState<AllowlistFailure | null>(null);
  const [refreshIndex, setRefreshIndex] = useState(0);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [dialogPending, setDialogPending] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void listBetaAllowlist(
      {
        ...(appliedSearch ? { search: appliedSearch } : {}),
        ...(cursor ? { cursor } : {}),
        limit: PAGE_SIZE,
      },
      controller.signal,
    )
      .then((page) => {
        setEntries([...page.items]);
        setNextCursor(page.nextCursor);
        setSearchTruncated(page.searchTruncated);
        setFailure(null);
        setForbidden(false);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (error instanceof AdminApiError && error.status === 403) {
          setForbidden(true);
          setEntries([]);
          return;
        }
        setEntries([]);
        setFailure(describeAllowlistFailure(error));
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

  function openAdd() {
    setDialogError(null);
    setDialog({ kind: "add" });
  }

  function openEdit(entry: BetaAllowlistRow) {
    setDialogError(null);
    setDialog({ kind: "edit", entry });
  }

  function closeDialog() {
    if (dialogPending) return;
    setDialog(null);
    setDialogError(null);
  }

  /**
   * One submission path for add and edit, so validation and messaging stay
   * identical. A refusal — a duplicate, an invalid address — stays in the
   * open dialog as a plain message; nothing has changed and the operator's
   * typing is preserved.
   */
  async function submitEntry(fields: BetaAllowlistEntryFields) {
    if (dialog === null || dialogPending) return;
    setDialogPending(true);
    setDialogError(null);
    try {
      if (dialog.kind === "add") {
        const change = await createBetaAllowlistEntry({
          ...(fields.email === null ? {} : { email: fields.email }),
          ...(fields.walletAddress === null
            ? {}
            : { walletAddress: fields.walletAddress }),
          ...(fields.label === null ? {} : { label: fields.label }),
        });
        showToast(describeAllowlistChangeOutcome("added", change.admittedCount));
        setDialog(null);
        // The new entry sorts first by recency; reload the listing from the
        // top so the operator sees it where it now lives.
        restart(appliedSearch);
      } else {
        const previous = dialog.entry;
        // The edit states the entry in full: a cleared field travels as an
        // explicit null, so "blank" can never silently mean "keep".
        const change = await updateBetaAllowlistEntry({
          entryId: previous.entryId,
          email: fields.email,
          walletAddress: fields.walletAddress,
          label: fields.label,
        });
        showToast(
          describeAllowlistChangeOutcome("updated", change.admittedCount),
        );
        setDialog(null);
        // The row the operator acted on is the one thing that certainly
        // changed; it is updated in place rather than moving under them.
        setEntries((rows) =>
          rows.map((row) =>
            row.entryId === previous.entryId
              ? {
                  ...change.entry,
                  createdByDisplayName: previous.createdByDisplayName,
                }
              : row,
          ),
        );
      }
    } catch (error) {
      if (
        error instanceof AdminApiError &&
        error.code === "BETA_ALLOWLIST_ENTRY_NOT_FOUND"
      ) {
        // The entry vanished under the edit; the listing no longer has it.
        setDialog(null);
        showToast(describeAllowlistActionError(error), "error");
        restart(appliedSearch);
      } else {
        setDialogError(describeAllowlistActionError(error));
      }
    } finally {
      setDialogPending(false);
    }
  }

  /**
   * Removal confirms both consequences before anything happens: automatic
   * admission stops for the entry's identifiers, and nobody already approved
   * loses access — revoking a person is a separate action in the users area.
   */
  function requestRemoval(entry: BetaAllowlistRow) {
    void confirm({
      title: "Remove this allowlist entry?",
      description:
        "Future sign-ins with this entry's email or wallet address will no longer be admitted automatically — they will wait for review instead. Anyone already approved keeps their access: revoking a specific person's access is a separate action in the Users area.",
      confirmLabel: "Remove entry",
      tier: "danger",
      action: async () => {
        const outcome = await removeBetaAllowlistEntry(entry.entryId);
        showToast(
          outcome.removed
            ? "Allowlist entry removed. Existing approvals are unchanged."
            : "That entry was already removed. Nothing has changed.",
        );
        setEntries((rows) =>
          rows.filter((row) => row.entryId !== entry.entryId),
        );
      },
    });
  }

  if (forbidden) {
    return (
      <div className="admin-page">
        <PageHeader
          eyebrow="Workspace / Allowlist"
          title="Beta allowlist"
          description="Email and wallet addresses admitted to the closed beta in advance."
        />
        <AuthRestrictedState description="Your operator account is active, but it does not include permission to view the beta allowlist. You can continue using the operational tools assigned to your role." />
      </div>
    );
  }

  const searching = appliedSearch.length > 0;
  return (
    <div className="admin-page">
      <PageHeader
        eyebrow="Workspace / Allowlist"
        title="Beta allowlist"
        description="Email and wallet addresses admitted to the closed beta in advance, most recent change first. Adding an entry admits anyone already waiting; removing one never evicts anyone already approved."
        actions={
          canManage ? (
            <button
              type="button"
              className="admin-button admin-button--primary"
              onClick={openAdd}
            >
              Add entry
            </button>
          ) : undefined
        }
      />

      <form
        className="admin-ledger"
        aria-label="Search the beta allowlist"
        onSubmit={applySearch}
      >
        <div className="admin-section-heading">
          <div className="admin-field beta-allowlist__search">
            <label htmlFor="beta-allowlist-search">
              Search email or wallet address
            </label>
            <input
              id="beta-allowlist-search"
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
          <span className="admin-eyebrow">Loading the allowlist…</span>
        </section>
      ) : failure ? (
        <div role="alert">
          <EmptyState
            eyebrow="Allowlist unavailable"
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
      ) : entries.length === 0 ? (
        <EmptyState
          eyebrow={searching ? "No match" : "Invitation ledger"}
          title={
            searching
              ? "No allowlist entries match this search."
              : "No one has been added to the allowlist yet."
          }
          description={
            searching
              ? "Search matches the start of an email address or a wallet address. Clear the search to see every entry."
              : "Add an invitee's email or wallet address and they will be admitted automatically the first time they sign in."
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
            ) : canManage ? (
              <button
                type="button"
                className="admin-button admin-button--primary"
                onClick={openAdd}
              >
                Add entry
              </button>
            ) : undefined
          }
        />
      ) : (
        <BetaAllowlistLedger
          entries={entries}
          startIndex={cursorStack.length * PAGE_SIZE + 1}
          canManage={canManage}
          onEdit={openEdit}
          onRemove={requestRemoval}
        />
      )}

      {!loading && !failure && searchTruncated ? (
        <p className="beta-allowlist__note" role="status">
          This search reached the allowlist's match limit. Narrow the search to
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

      {dialog !== null ? (
        <BetaAllowlistEntryDialog
          key={dialog.kind === "edit" ? dialog.entry.entryId : "add"}
          open
          {...(dialog.kind === "edit" ? { entry: dialog.entry } : {})}
          pending={dialogPending}
          error={dialogError}
          onClose={closeDialog}
          onSubmit={submitEntry}
        />
      ) : null}
    </div>
  );
}
