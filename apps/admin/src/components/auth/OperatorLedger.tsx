import type { OperatorSummary } from "@packscout/contracts";
import { StatusBadge } from "../StatusBadge";

interface OperatorLedgerProps {
  operators: OperatorSummary[];
  currentOperatorId: string;
  onChangeRole: (operator: OperatorSummary) => void;
  onRotateCredential: (operator: OperatorSummary) => void;
  onToggleState: (operator: OperatorSummary) => void;
}

function roleLabel(role: OperatorSummary["role"]): string {
  return role === "admin" ? "Administrator" : "Data operator";
}

export function OperatorLedger({
  operators,
  currentOperatorId,
  onChangeRole,
  onRotateCredential,
  onToggleState,
}: OperatorLedgerProps) {
  return (
    <section className="admin-ledger" aria-labelledby="operators-ledger-title">
      <header className="admin-section-heading">
        <div>
          <span className="admin-eyebrow">Access ledger</span>
          <h2 id="operators-ledger-title">Provisioned operators</h2>
        </div>
        <span className="admin-section-count">
          {String(operators.length).padStart(2, "0")} accounts
        </span>
      </header>
      <div className="admin-ledger__rows">
        {operators.map((operator, index) => (
          <article key={operator.id}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <div>
              <strong>
                {operator.displayName}
                {operator.id === currentOperatorId ? " (you)" : ""}
              </strong>
              <p>
                {operator.email} · {roleLabel(operator.role)} · Last access {" "}
                {operator.lastAccessAt
                  ? new Date(operator.lastAccessAt).toLocaleDateString()
                  : "not recorded"}
              </p>
              <p>
                <button
                  type="button"
                  className="admin-button admin-button--secondary"
                  onClick={() => onChangeRole(operator)}
                >
                  Change role
                </button>{" "}
                <button
                  type="button"
                  className="admin-button admin-button--secondary"
                  onClick={() => onRotateCredential(operator)}
                >
                  Rotate credential
                </button>{" "}
                <button
                  type="button"
                  className={
                    operator.state === "active"
                      ? "admin-button admin-button--danger"
                      : "admin-button admin-button--secondary"
                  }
                  onClick={() => onToggleState(operator)}
                >
                  {operator.state === "active" ? "Disable access" : "Enable access"}
                </button>
              </p>
            </div>
            <StatusBadge
              label={operator.state === "active" ? "Active" : "Disabled"}
              tone={operator.state === "active" ? "ready" : "danger"}
            />
          </article>
        ))}
      </div>
    </section>
  );
}
