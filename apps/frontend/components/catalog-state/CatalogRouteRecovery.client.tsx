"use client";

import { useRouter } from "next/navigation";
import { DataReleaseUnavailable } from "./CatalogPageStates.client";

export function CatalogRouteRecovery() {
  const router = useRouter();
  return <DataReleaseUnavailable onRetry={() => router.refresh()} />;
}
