import { CatalogLoading } from "@/components/catalog-state";
import { DashboardPageHeader } from "@/components/shell/DashboardPageHeader";
import { DataReleaseStatusReporter } from "@/components/shell/DataReleaseStatus.client";

export default function AllRepacksLoading() {
  return (
    <>
      <DataReleaseStatusReporter status={{ state: "loading" }} />
      <DashboardPageHeader activeView="all-repacks" />
      <CatalogLoading surface="all-repacks" />
    </>
  );
}
