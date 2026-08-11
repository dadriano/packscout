import { fetchQuery } from "convex/nextjs";
import {
  getDashboardBundleResultSchema,
  getPublicPackResultSchema,
  getPublicShellStatusResultSchema,
  listPublicPacksResultSchema,
  publicReadError,
  type DashboardQueryInput,
  type GetDashboardBundleResult,
  type GetPublicPackInput,
  type GetPublicPackResult,
  type GetPublicShellStatusResult,
  type ListPublicPacksInput,
  type ListPublicPacksResult,
} from "@packscout/contracts";
import { api } from "../../../convex/_generated/api";
import {
  buildDemoCatalogPage,
  buildDemoDashboard,
  catalogDemoIsEnabled,
} from "./catalog-demo-data.server";

function convexUrl(): string | null {
  const value = process.env.NEXT_PUBLIC_CONVEX_URL?.trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.username ||
      parsed.password ||
      (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost")
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

export function publicCatalogLiveReadsConfigured(): boolean {
  return convexUrl() !== null;
}

export async function readPublicShellStatus(): Promise<GetPublicShellStatusResult> {
  if (catalogDemoIsEnabled()) {
    return { ok: true, data: { metadata: buildDemoDashboard().metadata } };
  }
  const url = convexUrl();
  if (url === null) return publicReadError("SNAPSHOT_UNAVAILABLE");
  try {
    return getPublicShellStatusResultSchema.parse(
      await fetchQuery(api.publicCatalog.getPublicShellStatus, {}, { url }),
    );
  } catch {
    return publicReadError("SNAPSHOT_UNAVAILABLE");
  }
}

export async function readDashboardBundle(
  input: DashboardQueryInput,
): Promise<GetDashboardBundleResult> {
  if (catalogDemoIsEnabled()) {
    return { ok: true, data: buildDemoDashboard(input) };
  }
  const url = convexUrl();
  if (url === null) return publicReadError("SNAPSHOT_UNAVAILABLE");
  try {
    return getDashboardBundleResultSchema.parse(
      await fetchQuery(api.publicCatalog.getDashboardBundle, input, { url }),
    );
  } catch {
    return publicReadError("SNAPSHOT_UNAVAILABLE");
  }
}

export async function readPublicPacks(
  input: ListPublicPacksInput,
): Promise<ListPublicPacksResult> {
  if (catalogDemoIsEnabled()) {
    return { ok: true, data: buildDemoCatalogPage(input) };
  }
  const url = convexUrl();
  if (url === null) return publicReadError("SNAPSHOT_UNAVAILABLE");
  try {
    return listPublicPacksResultSchema.parse(
      await fetchQuery(api.publicCatalog.listPublicPacks, input, { url }),
    );
  } catch {
    return publicReadError("SNAPSHOT_UNAVAILABLE");
  }
}

export async function readPublicPack(
  input: GetPublicPackInput,
): Promise<GetPublicPackResult> {
  const url = convexUrl();
  if (url === null) return publicReadError("SNAPSHOT_UNAVAILABLE");
  try {
    return getPublicPackResultSchema.parse(
      await fetchQuery(api.publicCatalog.getPublicPack, input, { url }),
    );
  } catch {
    return publicReadError("SNAPSHOT_UNAVAILABLE");
  }
}
