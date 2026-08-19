import Link from "next/link";
import type { DashboardHref } from "@/lib/provider-banner";

export function DashboardPageHeader({
  activeView,
  overviewHref = "/",
}: {
  activeView: "overview" | "all-repacks";
  overviewHref?: DashboardHref;
}) {
  return (
    <div className="page-heading-row">
      <div className="dashboard-heading-group">
        <h1 className="page-heading" data-route-heading tabIndex={-1}>
          Dashboard
        </h1>
        <nav aria-label="Dashboard views" className="dashboard-tabs" role="tablist">
          <Link
            aria-current={activeView === "overview" ? "page" : undefined}
            aria-selected={activeView === "overview"}
            className="dashboard-tabs__tab"
            href={overviewHref}
            role="tab"
          >
            Overview
          </Link>
          <Link
            aria-current={activeView === "all-repacks" ? "page" : undefined}
            aria-selected={activeView === "all-repacks"}
            className="dashboard-tabs__tab"
            href="/packs"
            role="tab"
          >
            All Repacks
          </Link>
        </nav>
      </div>
      <p className="dashboard-disclaimer">PackScout EV · Estimated · Not financial advice.</p>
    </div>
  );
}
