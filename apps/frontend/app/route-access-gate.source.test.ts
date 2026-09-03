import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

/**
 * Wiring proof for the server-side gate (closed-beta-access/007): every page
 * resolves the visitor's access before it reads anything, and the routing
 * outcomes those pages act on are the ones proven behaviorally in
 * lib/access-gate.server.test.ts. Source assertions carry the composition;
 * the decision logic, the refusals, and the fail-closed paths all have
 * direct behavior tests beside the gate module.
 */

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const rootSource = source("./page.tsx");
const packsSource = source("./packs/page.tsx");
const learnSource = source("./learn/page.tsx");
const learnArticleSource = source("./learn/[slug]/page.tsx");
const accessSource = source("./access/page.tsx");
const layoutSource = source("./layout.tsx");
const robotsSource = source("./robots.ts");
const searchRouteSource = source("./api/collectibles/search/route.ts");
const rootLoadingSource = source("./loading.tsx");
const healthRouteSource = source("./api/health/route.ts");

function defaultExportBody(pageSource: string): string {
  const start = pageSource.indexOf("export default async function");
  assert.notEqual(start, -1);
  return pageSource.slice(start);
}

test("every gated page resolves access before any catalog read", () => {
  for (const [name, pageSource, read] of [
    ["root", rootSource, "readDashboardBundle("],
    ["packs", packsSource, "readPublicRepacks("],
    ["learn", learnSource, "readPublicCatalogRecordUpdateStatus("],
    [
      "learn article",
      learnArticleSource,
      "readPublicCatalogRecordUpdateStatus(",
    ],
  ] as const) {
    const body = defaultExportBody(pageSource);
    const gate = body.indexOf("await resolveVisitorAccess()");
    const firstRead = body.indexOf(read);
    assert.ok(gate !== -1, `${name} resolves access`);
    assert.ok(firstRead !== -1, `${name} still reads its data`);
    assert.ok(gate < firstRead, `${name} gates before reading`);
  }
});

test("the root branches totally: landing, product, or the holding redirect", () => {
  const body = defaultExportBody(rootSource);
  assert.match(body, /resolveRootRoute\(await resolveVisitorAccess\(\)\)/);
  assert.match(body, /if \(route\.kind === "redirect"\) redirect\(route\.destination\);/);
  assert.match(body, /route\.kind === "landing"/);
  assert.match(body, /<LandingPage \/>/);
  assert.match(body, /<ShellSurfaceReporter mode="gateway" \/>/);
});

test("gated pages redirect unadmitted visitors and declare the product shell face", () => {
  for (const pageSource of [packsSource, learnSource, learnArticleSource]) {
    const body = defaultExportBody(pageSource);
    assert.match(body, /resolveGatedRoute\(await resolveVisitorAccess\(\)\)/);
    assert.match(body, /if \(route\.kind === "redirect"\) redirect\(route\.destination\);/);
    assert.match(body, /<ShellSurfaceReporter mode="product" \/>/);
  }
});

test("the learn article gates before the guide lookup so slugs leak nothing", () => {
  const body = defaultExportBody(learnArticleSource);
  const gate = body.indexOf("resolveGatedRoute");
  const lookup = body.indexOf("findLearnGuide(");
  assert.ok(gate !== -1 && lookup !== -1 && gate < lookup);
});

test("the holding surface re-resolves server-side and renders from the gate's reason", () => {
  assert.match(accessSource, /resolveAccessRoute\(await resolveVisitorAccess\(\)\)/);
  assert.match(accessSource, /if \(route\.kind === "redirect"\) redirect\(route\.destination\);/);
  assert.match(accessSource, /<AccessHoldingNotice reason=\{route\.reason\} \/>/);
  assert.match(accessSource, /<ShellSurfaceReporter mode="gateway" \/>/);
  // Never indexed, in either switch position.
  assert.match(accessSource, /robots: \{ index: false, follow: false \}/);
  // The reason comes from the server resolution, never from the URL.
  assert.equal(accessSource.includes("searchParams"), false);
});

test("the layout seeds the shell face from the same request-scoped resolution", () => {
  assert.match(layoutSource, /shellSurfaceForDecision\(await resolveVisitorAccess\(\)\)/);
  assert.match(layoutSource, /<AppShell initialSurface=\{initialSurface\}>/);
});

test("gated surfaces carry the decision-driven robots metadata", () => {
  assert.match(rootSource, /rootRouteMetadata\(await resolveVisitorAccess\(\)\)/);
  for (const pageSource of [packsSource, learnSource, learnArticleSource]) {
    assert.match(pageSource, /robots: gatedSurfaceRobots\(await resolveVisitorAccess\(\)\)|const robots = gatedSurfaceRobots\(await resolveVisitorAccess\(\)\)/);
  }
});

test("the robots surface serves the fail-closed policy dynamically", () => {
  assert.match(robotsSource, /robotsPolicyForGateStatus\(await readGateStatusForRequest\(\)\)/);
  assert.match(robotsSource, /export const dynamic = "force-dynamic";/);
});

test("catalog search is guarded before its handler and the health probe stays open", () => {
  assert.match(
    searchRouteSource,
    /createAccessGuardedHandler\(\s*resolveVisitorAccessForRequest,\s*createDesiredCollectibleSearchHandler\(searchPublicCollectibles\),?\s*\)/,
  );
  assert.equal(healthRouteSource.includes("resolveVisitorAccess"), false);
  assert.equal(healthRouteSource.includes("cookies"), false);
});

test("the retired standalone landing address stays retired", () => {
  assert.equal(existsSync(new URL("./welcome", import.meta.url)), false);
});

test("telemetry intake stays a write-only surface with fixed responses", () => {
  // Both intake routes remain open on purpose: they are same-origin locked,
  // parse-then-drop ingress handlers whose responses are fixed strings, so
  // they cannot become an unauthenticated channel for product data. The
  // response vocabulary is proven in their behavior tests; here we pin that
  // neither route grew a read of catalog data.
  for (const path of [
    "./api/telemetry/route.ts",
    "./api/public-read-failure/route.ts",
  ]) {
    const routeSource = source(path);
    assert.equal(routeSource.includes("public-repacks"), false);
    assert.equal(routeSource.includes("searchPublicCollectibles"), false);
    assert.match(routeSource, /createTelemetryIngressHandler/);
  }
});

test("the root loading fallback commits to neither surface before the decision resolves", () => {
  // The root serves the landing page to unadmitted visitors and the dashboard
  // to admitted ones, and this fallback streams before that is known. Dashboard
  // chrome here flashes catalog framing at signed-out visitors and leaves the
  // streamed document carrying two page headings.
  assert.doesNotMatch(rootLoadingSource, /DashboardPageHeader/u);
  assert.doesNotMatch(rootLoadingSource, /CatalogLoading/u);
  assert.doesNotMatch(rootLoadingSource, /DataReleaseStatusReporter/u);
  assert.doesNotMatch(rootLoadingSource, /<h1/u);
  // It still announces the wait to assistive technology.
  assert.match(rootLoadingSource, /aria-busy="true"/u);
  assert.match(rootLoadingSource, /role="status"/u);
});

// --- Credentialed reads: enumerated by caller, not by path ----------------

/**
 * The catalog reads that present the server-held credential
 * (closed-beta-access/005), derived from the module rather than listed here,
 * so a read added later is covered without anyone remembering to add it.
 */
function credentialedReadNames(): readonly string[] {
  const moduleSource = source("../lib/public-repacks.server.ts");
  const names: string[] = [];
  const declaration = /export async function (\w+)/gu;
  const starts: Array<{ name: string; index: number }> = [];
  for (const match of moduleSource.matchAll(declaration)) {
    starts.push({ name: match[1]!, index: match.index! });
  }
  for (const [position, start] of starts.entries()) {
    const end = starts[position + 1]?.index ?? moduleSource.length;
    if (moduleSource.slice(start.index, end).includes("catalogReadArguments(")) {
      names.push(start.name);
    }
  }
  return names;
}

/** Every routable source file under `app/`, tests excluded. */
function routeSourceFiles(): readonly string[] {
  const root = new URL("./", import.meta.url);
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter(
      (entry) =>
        (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
        !entry.includes(".test."),
    )
    .sort();
}

/** Whatever the file resolves the visitor's access through, if anything. */
const GATE_MARKERS = [
  "resolveVisitorAccess()",
  "resolveVisitorAccessForRequest",
  "createAccessGuardedHandler",
] as const;

/** The source with its import statements removed: only the module body. */
function moduleBody(fileSource: string): string {
  return fileSource.replace(/^import [\s\S]*?;$/gmu, "");
}

test("the credentialed catalog reads are the ones this enumeration covers", () => {
  // Derivation guard: a broken derivation must fail loudly, not silently
  // exempt every caller below.
  assert.deepEqual(credentialedReadNames(), [
    "readPublicShellStatus",
    "readPublicCatalogRecordUpdateStatus",
    "readDashboardBundle",
    "readPublicRepacks",
    "readPublicRepack",
    "searchPublicCollectibles",
    "readRepacksByDesiredCollectible",
  ]);
});

test("every caller of a credentialed catalog read resolves access first", () => {
  // The earlier enumeration covered read *paths*: the four gated pages. It
  // could not see a new, ungated caller of the same credentialed helper —
  // which is exactly how the not-found surfaces came to make an authorized
  // catalog read, and serialize release source and timestamps into the
  // client, for signed-out visitors on any unknown URL. This enumerates
  // callers, so an ungated one fails the build.
  const reads = credentialedReadNames();
  assert.ok(reads.length > 0, "the credentialed reads were derived");
  const callers: string[] = [];
  for (const file of routeSourceFiles()) {
    const fileSource = source(`./${file}`);
    if (!reads.some((read) => fileSource.includes(read))) continue;
    callers.push(file);
    const body = moduleBody(fileSource);
    const firstRead = Math.min(
      ...reads
        .map((read) => body.indexOf(read))
        .filter((index) => index !== -1),
    );
    if (!Number.isFinite(firstRead)) continue;
    const firstGate = Math.min(
      ...GATE_MARKERS.map((marker) => body.indexOf(marker)).filter(
        (index) => index !== -1,
      ),
    );
    assert.ok(
      Number.isFinite(firstGate),
      `${file} reads the closed catalog without resolving visitor access`,
    );
    assert.ok(
      firstGate < firstRead,
      `${file} must resolve visitor access before its first credentialed read`,
    );
  }
  // The walk really did reach the surfaces we know read the catalog.
  for (const expected of [
    "page.tsx",
    "packs/page.tsx",
    "learn/page.tsx",
    "learn/[slug]/page.tsx",
    "not-found.tsx",
    "learn/[slug]/not-found.tsx",
    "api/collectibles/search/route.ts",
  ]) {
    assert.ok(callers.includes(expected), `${expected} was enumerated`);
  }
});

test("the ungated not-found surfaces read the catalog only for admitted visitors", () => {
  // These answer unknown URLs for signed-out visitors, so they cannot
  // redirect the way a gated page does. They withhold the credentialed read
  // instead: an unadmitted visitor gets the same bounded unavailable state a
  // missing backend produces, and no release source or timestamp at all.
  for (const path of ["./not-found.tsx", "./learn/[slug]/not-found.tsx"]) {
    const body = defaultExportBody(source(path));
    assert.match(body, /resolveGatedRoute\(await resolveVisitorAccess\(\)\)/u);
    assert.match(
      body,
      /route\.kind === "render"\s*\?\s*await readPublicCatalogRecordUpdateStatus\(\)\s*:\s*publicReadError\("RELEASE_UNAVAILABLE"\)/u,
    );
  }
});
