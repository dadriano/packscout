import type { OperatorSummary } from "@packscout/contracts";
import { StatusBadge, type StatusTone } from "../StatusBadge";

interface OperatorLedgerProps {
  operators: OperatorSummary[];
  currentOperatorId: string;
  onChangeRole: (operator: OperatorSummary) => void;
  onRotateCredential: (operator: OperatorSummary) => void;
  onToggleState: (operator: OperatorSummary) => void;
  onReissueInvitation: (operator: OperatorSummary) => void;
  onCancelInvitation: (operator: OperatorSummary) => void;
}

function roleLabel(role: OperatorSummary["role"]): string {
  return role === "admin" ? "Administrator" : "Data operator";
}

/**
 * One badge per account state, so pending, invitation-expired, active,
 * disabled, and cancelled are each distinguishable at a glance. An expired
 * invitation is a distinct reading of the pending state rather than a state
 * of its own: the account is still waiting, but its link no longer works.
 */
export function operatorStatus(
  operator: OperatorSummary,
): { label: string; tone: StatusTone } {
  if (operator.state === "pending") {
    if (!operator.invitation) {
      return { label: "Invitation withdrawn", tone: "danger" };
    }
    return operator.invitation.expired
      ? { label: "Invitation expired", tone: "danger" }
      : { label: "Invitation sent", tone: "pending" };
  }
  if (operator.state === "cancelled") {
    return { label: "Cancelled", tone: "neutral" };
  }
  return operator.state === "active"
    ? { label: "Active", tone: "ready" }
    : { label: "Disabled", tone: "danger" };
}

function invitationDetail(operator: OperatorSummary): string {
  if (operator.state === "cancelled") return "Invitation cancelled";
  if (operator.state !== "pending") {
    return `Last access ${
      operator.lastAccessAt
        ? new Date(operator.lastAccessAt).toLocaleDateString()
        : "not recorded"
    }`;
  }
  if (!operator.invitation) return "No invitation outstanding";
  const sent = new Date(operator.invitation.sentAt).toLocaleDateString();
  const expiry = new Date(operator.invitation.expiresAt).toLocaleDateString();
  return operator.invitation.expired
    ? `Invited ${sent} · link expired ${expiry}`
    : `Invited ${sent} · link valid until ${expiry}`;
}

export function OperatorLedger({
  operators,
  currentOperatorId,
  onChangeRole,
  onRotateCredential,
  onToggleState,
  onReissueInvitation,
  onCancelInvitation,
}: OperatorLedgerProps) {
  return (
    <section className="admin-surface admin-panel" aria-labelledby="operators-ledger-title">
      <header className="admin-section-header">
        <div>
          <span className="admin-kicker">Access ledger</span>
          <h2 id="operators-ledger-title">Provisioned operators</h2>
        </div>
        <span className="admin-section-count">
          {String(operators.length).padStart(2, "0")} accounts
        </span>
      </header>
      <div className="admin-row-list">
        {operators.map((operator, index) => {
          const status = operatorStatus(operator);
          const awaitingActivation = operator.state === "pending";
          const cancelled = operator.state === "cancelled";
          return (
            <article key={operator.id}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div>
                <strong>
                  {operator.displayName}
                  {operator.id === currentOperatorId ? " (you)" : ""}
                </strong>
                <p>
                  {operator.email} · {roleLabel(operator.role)} ·{" "}
                  {invitationDetail(operator)}
                </p>
                {awaitingActivation ? (
                  <p>
                    <button
                      type="button"
                      className="admin-button admin-button-secondary"
                      onClick={() => onReissueInvitation(operator)}
                    >
                      Resend invitation
                    </button>{" "}
                    <button
                      type="button"
                      className="admin-button admin-button-danger"
                      onClick={() => onCancelInvitation(operator)}
                    >
                      Cancel invitation
                    </button>
                  </p>
                ) : cancelled ? null : (
                  <p>
                    <button
                      type="button"
                      className="admin-button admin-button-secondary"
                      onClick={() => onChangeRole(operator)}
                    >
                      Change role
                    </button>{" "}
                    <button
                      type="button"
                      className="admin-button admin-button-secondary"
                      onClick={() => onRotateCredential(operator)}
                    >
                      Rotate credential
                    </button>{" "}
                    <button
                      type="button"
                      className={
                        operator.state === "active"
                          ? "admin-button admin-button-danger"
                          : "admin-button admin-button-secondary"
                      }
                      onClick={() => onToggleState(operator)}
                    >
                      {operator.state === "active"
                        ? "Disable access"
                        : "Enable access"}
                    </button>
                  </p>
                )}
              </div>
              <StatusBadge label={status.label} tone={status.tone} />
            </article>
          );
        })}
      </div>
    </section>
  );
}
