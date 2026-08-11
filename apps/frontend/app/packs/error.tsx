"use client";

import { CatalogRouteRecovery } from "@/components/catalog-state";
import { DashboardPageHeader } from "@/components/shell/DashboardPageHeader";
import { ShellStatusReporter } from "@/components/shell/SnapshotStatus.client";

export default function AllPacksError() {
  return (
    <>
      <ShellStatusReporter status={{ state: "unavailable" }} />
      <DashboardPageHeader activeView="all-packs" />
      <CatalogRouteRecovery />
    </>
  );
}
