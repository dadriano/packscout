export type GlobalDestination = "dashboard" | "learn" | null;
export type DashboardView = "overview" | "all-packs" | null;

type ShortcutEvent = Readonly<{
  altKey: boolean;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  target: EventTarget | null;
}>;

export function resolveGlobalDestination(pathname: string): GlobalDestination {
  if (pathname === "/" || pathname === "/packs") return "dashboard";
  if (pathname === "/learn" || pathname.startsWith("/learn/")) return "learn";
  return null;
}

export function resolveDashboardView(pathname: string): DashboardView {
  if (pathname === "/") return "overview";
  if (pathname === "/packs") return "all-packs";
  return null;
}

export function normalizeCatalogQuery(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

export function catalogSearchHref(value: string): string {
  const query = normalizeCatalogQuery(value);
  if (!query) return "/packs";

  const params = new URLSearchParams({ q: query });
  return `/packs?${params.toString()}`;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") return false;
  const candidate = target as EventTarget & {
    readonly isContentEditable?: boolean;
    readonly tagName?: string;
  };
  const tagName = candidate.tagName?.toLowerCase();
  return (
    candidate.isContentEditable === true ||
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select"
  );
}

export function shouldFocusCatalogSearch(event: ShortcutEvent): boolean {
  return (
    !event.altKey &&
    (event.metaKey || event.ctrlKey) &&
    event.key.toLowerCase() === "k" &&
    !isEditableTarget(event.target)
  );
}
