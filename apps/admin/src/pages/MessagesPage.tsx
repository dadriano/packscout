import { useEffect, useState, type FormEvent } from "react";
import type {
  EmailMessageIntentState,
  MessageDeliveryCounts,
  MessageDeliveryIntentRow,
} from "@packscout/contracts";
import { AdminApiError } from "../api/client";
import { countMessageDeliveries, listMessageDeliveries } from "../api/messages";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { AuthRestrictedState } from "../components/auth/AuthRestrictedState";
import { MessageDeliveryLedger } from "../components/messages/MessageDeliveryLedger";
import {
  KNOWN_MESSAGE_KINDS,
  describeMessageDeliveryFailure,
  type MessageDeliveryFailure,
} from "../components/messages/message-delivery-copy";
import { KeysetPagination } from "../components/operations/KeysetPagination";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

const PAGE_SIZE = 20;

const intentStates: readonly { value: EmailMessageIntentState; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "retrying", label: "Retrying" },
  { value: "sent", label: "Sent" },
  { value: "skipped", label: "Skipped" },
  { value: "failed", label: "Failed" },
];

interface AppliedFilters {
  readonly state: EmailMessageIntentState | "";
  readonly kind: string;
  readonly recipient: string;
}

const noFilters: AppliedFilters = { state: "", kind: "", recipient: "" };

/**
 * The delivery history: what the outbox was asked to send, to whom, when,
 * through which provider, and what happened. Recipient addresses render as
 * page content only — every read is a POST with a body, filters live in
 * component state, and nothing personal ever reaches a URL, a query string,
 * or the browser history. The queue-state counts sit above the listing so a
 * stuck queue is noticed rather than discovered by paging.
 */
export function MessagesPage() {
  useDocumentTitle("Messages");
  const [entries, setEntries] = useState<MessageDeliveryIntentRow[]>([]);
  const [counts, setCounts] = useState<MessageDeliveryCounts | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([]);
  const [stateDraft, setStateDraft] = useState<EmailMessageIntentState | "">("");
  const [kindDraft, setKindDraft] = useState("");
  const [recipientDraft, setRecipientDraft] = useState("");
  const [recipientError, setRecipientError] = useState<string | null>(null);
  const [applied, setApplied] = useState<AppliedFilters>(noFilters);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [failure, setFailure] = useState<MessageDeliveryFailure | null>(null);
  const [refreshIndex, setRefreshIndex] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      listMessageDeliveries(
        {
          ...(applied.state ? { state: applied.state } : {}),
          ...(applied.kind ? { kind: applied.kind } : {}),
          ...(applied.recipient ? { recipient: applied.recipient } : {}),
          ...(cursor ? { cursor } : {}),
          limit: PAGE_SIZE,
        },
        controller.signal,
      ),
      countMessageDeliveries(controller.signal),
    ])
      .then(([page, queueCounts]) => {
        setEntries([...page.items]);
        setNextCursor(page.nextCursor);
        setCounts(queueCounts);
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
        setCounts(null);
        setFailure(describeMessageDeliveryFailure(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [applied, cursor, refreshIndex]);

  function restart(filters: AppliedFilters) {
    setCursor(undefined);
    setCursorStack([]);
    setApplied(filters);
    setLoading(true);
    setRefreshIndex((value) => value + 1);
  }

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const recipient = recipientDraft.trim();
    if (recipient.length > 0 && recipient.length < 3) {
      setRecipientError("Enter the full recipient address.");
      return;
    }
    setRecipientError(null);
    restart({ state: stateDraft, kind: kindDraft, recipient });
  }

  function clearFilters() {
    setStateDraft("");
    setKindDraft("");
    setRecipientDraft("");
    setRecipientError(null);
    restart(noFilters);
  }

  if (forbidden) {
    return (
      <div className="admin-page">
        <PageHeader
          eyebrow="Workspace / Messages"
          title="Message delivery"
          description="Every message PackScout was asked to send, with its delivery outcome."
        />
        <AuthRestrictedState description="Your operator account is active, but it does not include permission to view message delivery. You can continue using the operational tools assigned to your role." />
      </div>
    );
  }

  const filtering =
    applied.state !== "" || applied.kind !== "" || applied.recipient !== "";
  return (
    <div className="admin-page">
      <PageHeader
        eyebrow="Workspace / Messages"
        title="Message delivery"
        description="Every message PackScout was asked to send, newest first: what kind, to whom, through which provider, and what happened. The log records outcomes, never message content."
      />

      {counts !== null && !loading ? (
        <section className="admin-overview-grid" aria-label="Delivery queue state">
          <article className="admin-metric-card admin-metric-card--inline">
            <span className="admin-metric-card__index" aria-hidden="true">
              P
            </span>
            <div>
              <small>Pending</small>
              <strong>{counts.pending}</strong>
            </div>
          </article>
          <article className="admin-metric-card admin-metric-card--inline">
            <span className="admin-metric-card__index" aria-hidden="true">
              R
            </span>
            <div>
              <small>Retrying</small>
              <strong>{counts.retrying}</strong>
            </div>
          </article>
          <article className="admin-metric-card admin-metric-card--inline">
            <span
              className={`admin-metric-card__index${counts.failed > 0 ? " messages__metric-danger" : ""}`}
              aria-hidden="true"
            >
              F
            </span>
            <div>
              <small>Failed</small>
              <strong>{counts.failed}</strong>
            </div>
          </article>
          <article className="admin-metric-card admin-metric-card--inline">
            <span className="admin-metric-card__index" aria-hidden="true">
              S
            </span>
            <div>
              <small>Sent</small>
              <strong>{counts.sent}</strong>
            </div>
          </article>
        </section>
      ) : null}

      <form
        className="messages__filters"
        aria-label="Filter the delivery history"
        onSubmit={applyFilters}
      >
        <div className="admin-field">
          <label htmlFor="messages-state">State</label>
          <select
            id="messages-state"
            value={stateDraft}
            onChange={(event) =>
              setStateDraft(event.target.value as EmailMessageIntentState | "")
            }
          >
            <option value="">All states</option>
            {intentStates.map((state) => (
              <option key={state.value} value={state.value}>
                {state.label}
              </option>
            ))}
          </select>
        </div>
        <div className="admin-field">
          <label htmlFor="messages-kind">Message kind</label>
          <select
            id="messages-kind"
            value={kindDraft}
            onChange={(event) => setKindDraft(event.target.value)}
          >
            <option value="">All kinds</option>
            {KNOWN_MESSAGE_KINDS.map((known) => (
              <option key={known.kind} value={known.kind}>
                {known.label}
              </option>
            ))}
          </select>
        </div>
        <div className="admin-field messages__search">
          <label htmlFor="messages-recipient">Search by recipient address</label>
          <input
            id="messages-recipient"
            type="search"
            autoComplete="off"
            aria-describedby={recipientError ? "messages-recipient-error" : undefined}
            aria-invalid={recipientError !== null}
            value={recipientDraft}
            onChange={(event) => setRecipientDraft(event.target.value)}
          />
          {recipientError ? (
            <p className="admin-form-error" id="messages-recipient-error">
              {recipientError}
            </p>
          ) : null}
        </div>
        <button className="admin-button admin-button-secondary" type="submit">
          Apply filters
        </button>
        {filtering ? (
          <button
            type="button"
            className="admin-button admin-button-secondary"
            onClick={clearFilters}
          >
            Clear filters
          </button>
        ) : null}
      </form>

      {loading ? (
        <section className="admin-surface admin-panel" aria-busy="true" aria-live="polite">
          <span className="admin-kicker">Loading the delivery history…</span>
        </section>
      ) : failure ? (
        <div role="alert">
          <EmptyState
            eyebrow="Delivery records unavailable"
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
                    restart(applied);
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
          eyebrow={filtering ? "No match" : "Delivery history"}
          title={
            filtering
              ? "No delivery records match these filters."
              : "No messages have been queued yet."
          }
          description={
            filtering
              ? "The recipient search matches a full address exactly. Clear the filters to see the whole history."
              : "The first alert, access decision, welcome, or account email PackScout sends will be recorded here with its delivery outcome."
          }
          action={
            filtering ? (
              <button
                type="button"
                className="admin-button admin-button-secondary"
                onClick={clearFilters}
              >
                Clear filters
              </button>
            ) : undefined
          }
        />
      ) : (
        <MessageDeliveryLedger
          entries={entries}
          startIndex={cursorStack.length * PAGE_SIZE + 1}
        />
      )}

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
