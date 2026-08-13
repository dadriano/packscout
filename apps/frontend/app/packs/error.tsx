"use client";

import { CatalogRouteRecovery } from "@/components/catalog-state";
import { DashboardPageHeader } from "@/components/shell/DashboardPageHeader";
import { DataReleaseStatusReporter } from "@/components/shell/DataReleaseStatus.client";

export default function AllRepacksError() {
  return (
    <>
      <DataReleaseStatusReporter status={{ state: "unavailable" }} />
      <DashboardPageHeader activeView="all-repacks" />
      <CatalogRouteRecovery />
    </>
  );
}
