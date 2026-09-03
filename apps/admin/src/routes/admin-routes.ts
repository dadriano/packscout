/**
 * One description of every admin destination.
 *
 * The sidebar, the document title, and the breadcrumb trail all read from
 * this list so a destination's label and its permission gate are declared
 * exactly once. Adding a page means adding a row here and a `<Route>` in
 * `App.tsx` — never a second per-page label table.
 */

export type AdminNavSectionId = "workspace" | "pipeline" | "data";

export interface AdminDestination {
  /**
   * Path below the root, without its leading slash. The empty string is the
   * index route at `/`. A destination that lives under a shared prefix
   * declares the whole path, for example `data/canonical`; the prefix itself
   * is not a destination and is labelled through `NESTED_SEGMENT_TITLES`.
   */
  readonly segment: string;
  /** Short label used in the sidebar. */
  readonly navLabel: string;
  /** Descriptive label used for the document title and breadcrumb trail. */
  readonly title: string;
  readonly section: AdminNavSectionId;
  /** Permission required to see the destination at all. */
  readonly permission?: string;
}

export const ROOT_TITLE = "Overview";
export const NOT_FOUND_TITLE = "Not found";

export const ADMIN_DESTINATIONS: readonly AdminDestination[] = [
  { segment: "", navLabel: "Overview", title: ROOT_TITLE, section: "workspace" },
  {
    segment: "operators",
    navLabel: "Operators",
    title: "Operators",
    section: "workspace",
    permission: "operators:manage",
  },
  {
    segment: "users",
    navLabel: "Users",
    title: "Users",
    section: "workspace",
    permission: "product_users:view",
  },
  {
    segment: "allowlist",
    navLabel: "Allowlist",
    title: "Allowlist",
    section: "workspace",
    permission: "beta_allowlist:view",
  },
  {
    segment: "messages",
    navLabel: "Messages",
    title: "Messages",
    section: "workspace",
    permission: "message_delivery:view",
  },
  {
    segment: "operations",
    navLabel: "Status",
    title: "Pipeline Status",
    section: "pipeline",
    permission: "providers:view",
  },
  {
    segment: "providers",
    navLabel: "Providers",
    title: "Data Providers",
    section: "pipeline",
    permission: "providers:view",
  },
  {
    segment: "source-configuration",
    navLabel: "Sources",
    title: "Source Configuration",
    section: "pipeline",
    permission: "providers:view",
  },
  {
    segment: "runs",
    navLabel: "Import Runs",
    title: "Import Runs",
    section: "pipeline",
    permission: "providers:view",
  },
  {
    segment: "background-work",
    navLabel: "Background Work",
    title: "Background Work",
    section: "pipeline",
    permission: "providers:view",
  },
  {
    segment: "workers",
    navLabel: "Workers",
    title: "Workers",
    section: "pipeline",
    permission: "providers:view",
  },
  {
    segment: "alerts",
    navLabel: "Alerts",
    title: "Operational Alerts",
    section: "pipeline",
    permission: "providers:view",
  },
  {
    segment: "quarantine",
    navLabel: "Quarantine",
    title: "Quarantine",
    section: "pipeline",
    permission: "providers:view",
  },
  {
    segment: "data/canonical",
    navLabel: "Canonical",
    title: "Canonical Data",
    section: "data",
    permission: "data_inspection:view",
  },
  {
    segment: "data/published",
    navLabel: "Published",
    title: "Published Data",
    section: "data",
    permission: "data_inspection:view",
  },
  {
    segment: "data/compare",
    navLabel: "Compare",
    title: "Data Comparison",
    section: "data",
    permission: "data_inspection:view",
  },
];

/** Literal segments that appear below a destination rather than as one. */
const NESTED_SEGMENT_TITLES: Record<string, string> = {
  new: "New",
  edit: "Edit",
  data: "Data",
};

/**
 * Route patterns that resolve to a real page, mirroring the `<Route>` tree in
 * `App.tsx`. Breadcrumbs only link a segment that matches one of these, so an
 * intermediate identifier never links into the catch-all route.
 */
export const ROUTABLE_PATTERNS: readonly string[] = [
  "/",
  "/operators",
  "/users",
  "/users/:handle",
  "/allowlist",
  "/messages",
  "/messages/:intentId",
  "/providers",
  "/providers/new",
  "/providers/:providerId",
  "/providers/:providerId/edit",
  "/source-configuration",
  "/operations",
  "/runs",
  "/runs/:runId",
  "/background-work",
  "/workers",
  "/quarantine",
  "/quarantine/:quarantineId",
  "/alerts",
  "/alerts/:alertId",
  "/data/canonical",
  "/data/published",
  "/data/compare",
];

export interface AdminNavItem {
  readonly to: string;
  readonly label: string;
  readonly end: boolean;
}

export interface AdminNavSection {
  readonly id: AdminNavSectionId;
  readonly heading: string;
  readonly items: readonly AdminNavItem[];
}

const SECTION_HEADINGS: Record<AdminNavSectionId, string> = {
  workspace: "Workspace",
  pipeline: "Data pipeline",
  data: "Data",
};

/** Sidebar sections in presentation order. */
const SECTION_ORDER = ["workspace", "pipeline", "data"] as const;

function destinationPath(destination: AdminDestination): string {
  return destination.segment ? `/${destination.segment}` : "/";
}

function isGranted(
  destination: AdminDestination,
  permissions: readonly string[],
): boolean {
  if (!destination.permission) return true;
  return permissions.some((granted) => granted === destination.permission);
}

/** The sidebar sections an operator may see, in presentation order. */
export function navigationSections(
  permissions: readonly string[],
): readonly AdminNavSection[] {
  const sections: AdminNavSection[] = [];
  for (const id of SECTION_ORDER) {
    const items = ADMIN_DESTINATIONS.filter(
      (destination) =>
        destination.section === id && isGranted(destination, permissions),
    ).map((destination) => ({
      to: destinationPath(destination),
      label: destination.navLabel,
      end: destination.segment === "",
    }));
    if (items.length > 0) {
      sections.push({ id, heading: SECTION_HEADINGS[id], items });
    }
  }
  return sections;
}

/**
 * The destination a path belongs to: the most specific declared path that the
 * pathname starts with. Matching longest-first is what lets `data/canonical`
 * win over a hypothetical `data`, so a nested destination keeps its own title
 * instead of inheriting its prefix's.
 */
function destinationForPath(pathname: string): AdminDestination | undefined {
  const segments = pathname.split("/").filter(Boolean);
  for (let depth = segments.length; depth > 0; depth -= 1) {
    const candidatePath = segments.slice(0, depth).join("/");
    const destination = ADMIN_DESTINATIONS.find(
      (candidate) => candidate.segment === candidatePath,
    );
    if (destination) return destination;
  }
  return undefined;
}

/** The document title for a path, resolved from its declared destination. */
export function pageTitleForPath(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return ROOT_TITLE;
  return destinationForPath(pathname)?.title ?? NOT_FOUND_TITLE;
}

/**
 * The breadcrumb label for one crumb, addressed by its cumulative path so a
 * nested destination resolves to its own title. A path that declares no
 * destination falls back to a literal nested label, then to the raw segment,
 * matching the address bar.
 */
export function breadcrumbLabel(path: string): string {
  const segments = path.split("/").filter(Boolean);
  const last = segments.at(-1) ?? "";
  const declaredPath = segments.join("/");
  const destination = ADMIN_DESTINATIONS.find(
    (candidate) => candidate.segment === declaredPath,
  );
  return destination?.title ?? NESTED_SEGMENT_TITLES[last] ?? last;
}
