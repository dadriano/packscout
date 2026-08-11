"use client";

import { useRouter } from "next/navigation";
import { SnapshotUnavailable } from "./CatalogPageStates.client";

export function CatalogRouteRecovery() {
  const router = useRouter();
  return <SnapshotUnavailable onRetry={() => router.refresh()} />;
}
