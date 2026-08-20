import { METRIC_TRUST_COPY } from "@/lib/metric-vocabulary";

export function DashboardDisclaimer() {
  return (
    <p className="dashboard-disclaimer" role="note">
      {METRIC_TRUST_COPY.dashboardDisclaimer}
    </p>
  );
}
