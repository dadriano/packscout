import { useEffect, useState } from "react";
import type { MessageDeliveryDetail } from "@packscout/contracts";
import { Link, useParams } from "react-router-dom";
import { AdminApiError } from "../api/client";
import { getMessageDelivery, retryMessageDelivery } from "../api/messages";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import { AuthRestrictedState } from "../components/auth/AuthRestrictedState";
import {
  describeRetryError,
  messageKindLabel,
  messageStateDisplay,
  skipReasonLabel,
} from "../components/messages/message-delivery-copy";
import { dateTime } from "../components/operations/OperationStatus";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useConfirm } from "../providers/confirm";
import { useSession } from "../providers/session";
import { useToast } from "../providers/toast";

type LoadError = "not_found" | "forbidden" | "unavailable";

/**
 * One delivery intent with its full attempt history: each attempt's time,
 * provider, outcome, stable error code, and — on success — the provider's own
 * message identifier, so a delivery can be correlated with the provider's
 * records. The URL carries only the queue's opaque intent id; the recipient
 * renders as page content.
 *
 * The one affordance here is the guarded retry: a terminally failed intent
 * re-enters the normal queue after an explicit confirmation. The server
 * refuses anything not terminally failed, and concurrent retries converge.
 */
export function MessageDetailPage() {
  const { intentId = "" } = useParams();
  const { status } = useSession();
  const { confirm } = useConfirm();
  const { showToast } = useToast();
  const [detail, setDetail] = useState<MessageDeliveryDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<LoadError | null>(null);
  const [refreshIndex, setRefreshIndex] = useState(0);
  const canManage =
    status.phase === "authenticated" &&
    status.session.permissions.includes("message_delivery:manage");
  useDocumentTitle(
    detail ? `${messageKindLabel(detail.intent.kind)} delivery` : "Message",
  );

  useEffect(() => {
    const controller = new AbortController();
    void getMessageDelivery(intentId, controller.signal)
      .then((next) => {
        setDetail(next);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setDetail(null);
        if (error instanceof AdminApiError && error.status === 403) {
          setLoadError("forbidden");
        } else if (
          error instanceof AdminApiError &&
          (error.status === 404 || error.status === 422)
        ) {
          // An unknown id and a malformed id read the same to an operator:
          // there is no such delivery record.
          setLoadError("not_found");
        } else {
          setLoadError("unavailable");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [intentId, refreshIndex]);

  function reload() {
    setLoading(true);
    setRefreshIndex((value) => value + 1);
  }

  function requestRetry() {
    if (detail === null) return;
    void confirm({
      title: "Retry this delivery?",
      description:
        "The message re-enters the delivery queue and the background worker sends it through the normal path — nothing is sent from this page. It receives one more bounded attempt; if that fails too, it rests as failed again. Retry after the underlying cause is fixed.",
      confirmLabel: "Retry delivery",
      action: async () => {
        try {
          const outcome = await retryMessageDelivery(detail.intent.intentId);
          setDetail((current) =>
            current ? { ...current, intent: outcome.intent } : current,
          );
          showToast(
            "Message queued for delivery again. The next drain pass will attempt it.",
          );
        } catch (error) {
          showToast(describeRetryError(error), "error");
          // Whatever refused the retry knows the intent's current truth
          // better than this page does; reload rather than guess.
          reload();
        }
      },
    });
  }

  const backLink = (
    <Link className="admin-button admin-button--secondary" to="/messages">
      Back to messages
    </Link>
  );

  if (loading) {
    return (
      <div className="admin-page">
        <section className="admin-ledger" aria-busy="true" aria-live="polite">
          <span className="admin-eyebrow">Loading the delivery record…</span>
        </section>
      </div>
    );
  }

  if (loadError === "forbidden") {
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

  if (loadError === "not_found" || detail === null) {
    return (
      <div className="admin-page">
        <EmptyState
          eyebrow={loadError === "unavailable" ? "Records unavailable" : "No record"}
          title={
            loadError === "unavailable"
              ? "The delivery records are temporarily unavailable."
              : "This delivery record no longer exists."
          }
          description={
            loadError === "unavailable"
              ? "Nothing has been changed. The queue keeps delivering on its own; try again once the connection recovers."
              : "Delivered history is pruned on the platform's retention schedule, so older records age out."
          }
          action={
            loadError === "unavailable" ? (
              <button
                type="button"
                className="admin-button admin-button--secondary"
                onClick={reload}
              >
                Try again
              </button>
            ) : (
              backLink
            )
          }
        />
      </div>
    );
  }

  const { intent, attempts } = detail;
  const state = messageStateDisplay(intent.state);
  return (
    <div className="admin-page">
      <PageHeader
        eyebrow="Workspace / Messages"
        title={`${messageKindLabel(intent.kind)} delivery`}
        description="The queue's record of this message: its state, every delivery attempt, and the provider evidence to correlate with."
        actions={
          <div className="messages__detail-actions">
            {canManage && intent.state === "failed" ? (
              <button
                type="button"
                className="admin-button admin-button--primary"
                onClick={requestRetry}
              >
                Retry delivery
              </button>
            ) : null}
            {backLink}
          </div>
        }
      />

      <section className="admin-ledger" aria-label="Delivery summary">
        <header className="admin-section-heading">
          <div className="messages__summary-lead">
            <span className="admin-eyebrow">Recipient</span>
            <h2 className="messages__recipient" title={intent.recipient}>
              {intent.recipient}
            </h2>
          </div>
          <StatusBadge label={state.label} tone={state.tone} />
        </header>
        <dl className="messages__facts messages__facts--summary">
          <div>
            <dt>Message kind</dt>
            <dd>{messageKindLabel(intent.kind)}</dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd className="messages__code">{intent.source}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{dateTime(intent.createdAt)}</dd>
          </div>
          <div>
            <dt>Attempts</dt>
            <dd>{intent.attemptCount}</dd>
          </div>
          <div>
            <dt>Last attempt</dt>
            <dd>{dateTime(intent.lastAttemptedAt)}</dd>
          </div>
          <div>
            <dt>Provider</dt>
            <dd>{intent.lastProvider ?? "None yet"}</dd>
          </div>
          {intent.lastErrorCode !== null ? (
            <div>
              <dt>Last error code</dt>
              <dd className="messages__code">{intent.lastErrorCode}</dd>
            </div>
          ) : null}
          {intent.lastSkipReason !== null ? (
            <div>
              <dt>Skipped</dt>
              <dd>{skipReasonLabel(intent.lastSkipReason)}</dd>
            </div>
          ) : null}
          {intent.state === "pending" || intent.state === "retrying" ? (
            <div>
              <dt>Next due</dt>
              <dd>{dateTime(intent.dueAt)}</dd>
            </div>
          ) : null}
          {intent.finalizedAt !== null ? (
            <div>
              <dt>Settled</dt>
              <dd>{dateTime(intent.finalizedAt)}</dd>
            </div>
          ) : null}
        </dl>
      </section>

      {attempts.length === 0 ? (
        <EmptyState
          eyebrow="Attempt history"
          title="No delivery attempts yet."
          description="The message is waiting in the queue; the next drain pass will attempt it."
        />
      ) : (
        <div
          className="messages-attempts"
          role="region"
          aria-label="Delivery attempt history"
          tabIndex={0}
        >
          <table>
            <thead>
              <tr>
                <th scope="col">Attempt</th>
                <th scope="col">Time</th>
                <th scope="col">Outcome</th>
                <th scope="col">Provider</th>
                <th scope="col">Error code</th>
                <th scope="col">Detail</th>
                <th scope="col">Provider message ID</th>
              </tr>
            </thead>
            <tbody>
              {attempts.map((attempt) => {
                const outcome = messageStateDisplay(attempt.outcome);
                return (
                  <tr key={attempt.attemptNumber}>
                    <td>{attempt.attemptNumber}</td>
                    <td>{dateTime(attempt.attemptedAt)}</td>
                    <td>
                      <StatusBadge label={outcome.label} tone={outcome.tone} />
                    </td>
                    <td>{attempt.provider ?? "None"}</td>
                    <td className="messages__code">{attempt.errorCode ?? "—"}</td>
                    <td>
                      {attempt.skipReason !== null
                        ? skipReasonLabel(attempt.skipReason)
                        : (attempt.errorMessage ?? "—")}
                    </td>
                    <td className="messages__code">
                      {attempt.providerMessageId ?? "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
