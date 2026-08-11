import { CatalogLoading } from "@/components/catalog-state";
import { DashboardPageHeader } from "@/components/shell/DashboardPageHeader";
import { ShellStatusReporter } from "@/components/shell/SnapshotStatus.client";

export default function DashboardLoading() {
  return (
    <>
      <ShellStatusReporter status={{ state: "loading" }} />
      <DashboardPageHeader activeView="overview" />
      <CatalogLoading surface="overview" />
    </>
  );
}
