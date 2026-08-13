import { CatalogLoading } from "@/components/catalog-state";
import { DashboardPageHeader } from "@/components/shell/DashboardPageHeader";
import { DataReleaseStatusReporter } from "@/components/shell/DataReleaseStatus.client";

export default function DashboardLoading() {
  return (
    <>
      <DataReleaseStatusReporter status={{ state: "loading" }} />
      <DashboardPageHeader activeView="overview" />
      <CatalogLoading surface="overview" />
    </>
  );
}
