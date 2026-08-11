import Link from "next/link";

export function DashboardPageHeader({
  activeView,
}: {
  activeView: "overview" | "all-packs";
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
            href="/"
            role="tab"
          >
            Overview
          </Link>
          <Link
            aria-current={activeView === "all-packs" ? "page" : undefined}
            aria-selected={activeView === "all-packs"}
            className="dashboard-tabs__tab"
            href="/packs"
            role="tab"
          >
            All Packs
          </Link>
        </nav>
      </div>
      <p className="dashboard-disclaimer">Estimated EV · Not financial advice.</p>
    </div>
  );
}
