import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getAdminHealth } from "../api/health";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import { useToast } from "../providers/toast";

type ServiceState = "checking" | "online" | "offline";

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
        eyebrow="Workspace / Overview"
        title="Overview"
        description="Whether the admin service is reachable, and what to do next."
        actions={
          <button
            type="button"
            className="admin-button admin-button-secondary"
            onClick={() => void recheckService()}
            disabled={serviceState === "checking"}
          >
            {serviceState === "checking" ? "Checking service…" : "Recheck service"}
          </button>
        }
      />

      <section className="admin-overview-grid" aria-label="Service status">
        <article className="admin-metric-card admin-metric-card--inline">
          <div>
            <small>Admin service</small>
            <strong>{serviceState === "online" ? "Reachable" : serviceState === "offline" ? "Needs attention" : "Connecting"}</strong>
          </div>
          {serviceBadge(serviceState)}
        </article>
      </section>

      <EmptyState
        eyebrow="Next step"
        title="Set up your first provider."
        description="Configure a source and test it before enabling imports."
        action={
          <Link className="admin-button admin-button-primary" to="/providers">
            Go to providers
          </Link>
        }
      />
    </div>
  );
}
