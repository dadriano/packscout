import { useCallback, useEffect, useState } from "react";
import { getAdminHealth } from "../api/health";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge, type StatusTone } from "../components/StatusBadge";
import { useToast } from "../providers/toast";

type ServiceState = "checking" | "online" | "offline";

const guardrails: Array<{
  index: string;
  guardrail: string;
  proof: string;
  label: string;
  tone: StatusTone;
}> = [
  {
    index: "01",
    guardrail: "Runtime boundaries",
    proof: "Browser and server imports are checked independently.",
    label: "Enforced",
    tone: "ready",
  },
  {
    index: "02",
    guardrail: "HTTP error contract",
    proof: "Unknown routes and invalid JSON return stable error codes.",
    label: "Enforced",
    tone: "ready",
  },
  {
    index: "03",
    guardrail: "Behavior coverage",
    proof: "Tests are discovered by convention and scenarios map to proof.",
    label: "Active",
    tone: "ready",
  },
  {
    index: "04",
    guardrail: "Architecture ratchet",
    proof: "New drift fails the zero-debt framework baseline.",
    label: "Zero debt",
    tone: "ready",
  },
];

function serviceBadge(state: ServiceState) {
  if (state === "online") return <StatusBadge label="Online" tone="ready" />;
  if (state === "offline") return <StatusBadge label="Offline" tone="danger" />;
  return <StatusBadge label="Checking" tone="pending" />;
}

export function OverviewPage() {
  const { showToast } = useToast();
  const [serviceState, setServiceState] = useState<ServiceState>("checking");

  useEffect(() => {
    const controller = new AbortController();
    getAdminHealth(controller.signal)
      .then(() => setServiceState("online"))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setServiceState("offline");
      });
    return () => controller.abort();
  }, []);

  const recheckService = useCallback(async () => {
    setServiceState("checking");
    try {
      await getAdminHealth();
      setServiceState("online");
      showToast("Admin service is online.");
    } catch {
      setServiceState("offline");
      showToast("Admin service is not responding.", "error");
    }
  }, [showToast]);

  return (
    <div className="admin-page">
      <PageHeader
        eyebrow="Overview / 001"
        title="A clean base for the work ahead."
        description="The operator shell, API boundary, shared interaction patterns, and repository guardrails are in place without inventing product behavior before its contract exists."
        actions={
          <button
            type="button"
            className="admin-button admin-button--secondary"
            onClick={() => void recheckService()}
            disabled={serviceState === "checking"}
          >
            {serviceState === "checking" ? "Checking service…" : "Recheck service"}
          </button>
        }
      />

      <section className="admin-metrics" aria-label="Foundation status">
        <article>
          <span className="admin-metric__index">A</span>
          <div>
            <small>Admin service</small>
            <strong>{serviceState === "online" ? "Reachable" : serviceState === "offline" ? "Needs attention" : "Connecting"}</strong>
          </div>
          {serviceBadge(serviceState)}
        </article>
        <article>
          <span className="admin-metric__index">B</span>
          <div>
            <small>Framework baseline</small>
            <strong>Zero accepted drift</strong>
          </div>
          <StatusBadge label="Ratchet on" tone="ready" />
        </article>
        <article>
          <span className="admin-metric__index">C</span>
          <div>
            <small>Product modules</small>
            <strong>Ready for definition</strong>
          </div>
          <StatusBadge label="Unclaimed" tone="neutral" />
        </article>
      </section>

      <div className="admin-overview-grid">
        <section className="admin-ledger" aria-labelledby="guardrail-title">
          <header className="admin-section-heading">
            <div>
              <span className="admin-eyebrow">System ledger</span>
              <h2 id="guardrail-title">Guardrails carried forward</h2>
            </div>
            <span className="admin-section-count">04 controls</span>
          </header>
          <div className="admin-ledger__rows">
            {guardrails.map((item) => (
              <article key={item.index}>
                <span>{item.index}</span>
                <div>
                  <strong>{item.guardrail}</strong>
                  <p>{item.proof}</p>
                </div>
                <StatusBadge label={item.label} tone={item.tone} />
              </article>
            ))}
          </div>
        </section>

        <aside className="admin-contract" aria-labelledby="contract-title">
          <span className="admin-eyebrow">Boundary contract</span>
          <h2 id="contract-title">What the base does not pretend</h2>
          <dl>
            <div>
              <dt>Authentication</dt>
              <dd>Not configured</dd>
            </div>
            <div>
              <dt>Persistence</dt>
              <dd>Not selected</dd>
            </div>
            <div>
              <dt>Shared services</dt>
              <dd>Add on genuine reuse</dd>
            </div>
          </dl>
          <p>
            Each boundary arrives with its authorization, validation, and direct
            regression tests—not as a placeholder dependency.
          </p>
        </aside>
      </div>

      <EmptyState
        eyebrow="Next waypoint / 002"
        title="No operator modules have been claimed yet."
        description="Add the first real route when its actor, permissions, inputs, states, and service ownership are agreed. The shell can stay put while the product grows around it."
      />
    </div>
  );
}
