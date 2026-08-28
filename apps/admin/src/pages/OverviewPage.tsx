import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getAdminHealth } from "../api/health";
import { listProviders } from "../api/providers";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import { useSession } from "../providers/session";
import { useToast } from "../providers/toast";

type ServiceState = "checking" | "online" | "offline";

/** `null` while the count is unknown — loading, or the read failed. */
type ProviderCount = number | null;

function providerLabel(count: ProviderCount): string {
  if (count === null) return "Unavailable";
  if (count === 0) return "None yet";
  return `${count} configured`;
}

function serviceBadge(state: ServiceState) {
  if (state === "online") return <StatusBadge label="Online" tone="ready" />;
  if (state === "offline") return <StatusBadge label="Offline" tone="danger" />;
  return <StatusBadge label="Checking" tone="pending" />;
}

export function OverviewPage() {
  const { showToast } = useToast();
  const { status } = useSession();
  const [serviceState, setServiceState] = useState<ServiceState>("checking");
  const [providerCount, setProviderCount] = useState<ProviderCount>(null);

  // Setup guidance is only true for an operator who may administer Provider
  // Sources. `data_operator` holds `providers:view` without
  // `providers:manage`, so prompting it to configure a source would send it
  // to a surface where every mutation is correctly unavailable.
  const canManageProviders =
    status.phase === "authenticated" &&
    status.session.permissions.includes("providers:manage");

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

  useEffect(() => {
    let active = true;
    // A failed read leaves the count unknown rather than zero: claiming no
    // providers exist is worse than saying nothing about them.
    listProviders()
      .then((result) => { if (active) setProviderCount(result.items.length); })
      .catch(() => { if (active) setProviderCount(null); });
    return () => { active = false; };
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
        <article className="admin-metric-card admin-metric-card--inline">
          <div>
            <small>Providers</small>
            <strong>{providerLabel(providerCount)}</strong>
          </div>
          <Link className="admin-button admin-button-secondary" to="/providers">
            View
          </Link>
        </article>
      </section>

      {providerCount === 0 ? (
        canManageProviders ? (
          <EmptyState
            eyebrow="Next step"
            title="Set up your first provider source."
            description="Create and test it in Provider Sources before enabling imports."
            action={
              <Link className="admin-button admin-button-primary" to="/source-configuration">
                Configure Provider Sources
              </Link>
            }
          />
        ) : (
          <EmptyState
            eyebrow="Next step"
            title="No provider sources are configured yet."
            description="An administrator creates and enables one in Provider Sources before imports can run."
          />
        )
      ) : null}
    </div>
  );
}
