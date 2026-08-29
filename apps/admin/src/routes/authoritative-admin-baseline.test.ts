import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { permissionsForOperatorRole } from "@packscout/contracts";
import ts from "typescript";
import {
  ADMIN_DESTINATIONS,
  ROUTABLE_PATTERNS,
  navigationSections,
  pageTitleForPath,
} from "./admin-routes.ts";

const AUTHORITATIVE_DESTINATIONS = [
  ["", "Overview", "Overview", "workspace", undefined],
  ["operators", "Operators", "Operators", "workspace", "operators:manage"],
  ["users", "Users", "Users", "workspace", "product_users:view"],
  ["allowlist", "Allowlist", "Allowlist", "workspace", "beta_allowlist:view"],
  ["messages", "Messages", "Messages", "workspace", "message_delivery:view"],
  ["operations", "Status", "Pipeline Status", "pipeline", "providers:view"],
  ["providers", "Providers", "Data Providers", "pipeline", "providers:view"],
  [
    "source-configuration",
    "Sources",
    "Source Configuration",
    "pipeline",
    "providers:view",
  ],
  ["runs", "Import Runs", "Import Runs", "pipeline", "providers:view"],
  [
    "background-work",
    "Background Work",
    "Background Work",
    "pipeline",
    "providers:view",
  ],
  ["workers", "Workers", "Workers", "pipeline", "providers:view"],
  ["alerts", "Alerts", "Operational Alerts", "pipeline", "providers:view"],
  ["quarantine", "Quarantine", "Quarantine", "pipeline", "providers:view"],
  [
    "data/canonical",
    "Canonical",
    "Canonical Data",
    "data",
    "data_inspection:view",
  ],
  [
    "data/published",
    "Published",
    "Published Data",
    "data",
    "data_inspection:view",
  ],
  [
    "data/compare",
    "Compare",
    "Data Comparison",
    "data",
    "data_inspection:view",
  ],
] as const;

const AUTHORITATIVE_PROTECTED_ROUTES = [
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
] as const;

const AUTHORITATIVE_PUBLIC_ROUTES = [
  "/login",
  "/forgot-password",
  "/reset-password",
  "/accept-invitation",
] as const;

const APP_SOURCE_PATH = fileURLToPath(new URL("../App.tsx", import.meta.url));

function joinRoutePath(parentPath: string, path: string): string {
  if (path.startsWith("/")) return path;
  if (parentPath === "" || parentPath === "/") return `/${path}`;
  return `${parentPath}/${path}`;
}

function jsxAttribute(
  attributes: ts.JsxAttributes,
  name: string,
): ts.JsxAttribute | undefined {
  return attributes.properties.find(
    (attribute): attribute is ts.JsxAttribute =>
      ts.isJsxAttribute(attribute) && attribute.name.getText() === name,
  );
}

function stringAttributeValue(attribute: ts.JsxAttribute | undefined) {
  if (attribute?.initializer === undefined) return undefined;
  if (ts.isStringLiteral(attribute.initializer)) return attribute.initializer.text;
  return undefined;
}

/**
 * Reads the actual `<Route>` JSX registrations. Formatting, imports, and page
 * implementations may change freely; the guard follows nested pathless and
 * layout routes without executing pages that are still being transplanted.
 */
function registeredRoutePaths(source: string): Set<string> {
  const sourceFile = ts.createSourceFile(
    APP_SOURCE_PATH,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const paths = new Set<string>();

  function inspectRoute(
    attributes: ts.JsxAttributes,
    parentPath: string,
  ): string {
    const path = stringAttributeValue(jsxAttribute(attributes, "path"));
    const routePath = path === undefined ? parentPath : joinRoutePath(parentPath, path);
    if (path !== undefined || jsxAttribute(attributes, "index") !== undefined) {
      paths.add(routePath || "/");
    }
    return routePath;
  }

  function visit(node: ts.Node, parentPath: string): void {
    if (
      ts.isJsxSelfClosingElement(node) &&
      node.tagName.getText(sourceFile) === "Route"
    ) {
      inspectRoute(node.attributes, parentPath);
      return;
    }
    if (
      ts.isJsxElement(node) &&
      node.openingElement.tagName.getText(sourceFile) === "Route"
    ) {
      const routePath = inspectRoute(node.openingElement.attributes, parentPath);
      for (const child of node.children) visit(child, routePath);
      return;
    }
    ts.forEachChild(node, (child) => visit(child, parentPath));
  }

  visit(sourceFile, "");
  return paths;
}

function sectionProjection(permissions: readonly string[]) {
  return navigationSections(permissions).map((section) => ({
    id: section.id,
    heading: section.heading,
    items: section.items.map(({ to, label }) => ({ to, label })),
  }));
}

test("the authoritative commit-225f9a1 destination catalog remains intact", () => {
  assert.deepEqual(
    ADMIN_DESTINATIONS.map((destination) => [
      destination.segment,
      destination.navLabel,
      destination.title,
      destination.section,
      destination.permission,
    ]),
    AUTHORITATIVE_DESTINATIONS,
  );
  assert.deepEqual(ROUTABLE_PATTERNS, AUTHORITATIVE_PROTECTED_ROUTES);
});

test("administrator and data-operator navigation keep the current sections", () => {
  assert.deepEqual(
    sectionProjection(permissionsForOperatorRole("admin")),
    [
      {
        id: "workspace",
        heading: "Workspace",
        items: [
          { to: "/", label: "Overview" },
          { to: "/operators", label: "Operators" },
          { to: "/users", label: "Users" },
          { to: "/allowlist", label: "Allowlist" },
          { to: "/messages", label: "Messages" },
        ],
      },
      {
        id: "pipeline",
        heading: "Data pipeline",
        items: [
          { to: "/operations", label: "Status" },
          { to: "/providers", label: "Providers" },
          { to: "/source-configuration", label: "Sources" },
          { to: "/runs", label: "Import Runs" },
          { to: "/background-work", label: "Background Work" },
          { to: "/workers", label: "Workers" },
          { to: "/alerts", label: "Alerts" },
          { to: "/quarantine", label: "Quarantine" },
        ],
      },
      {
        id: "data",
        heading: "Data",
        items: [
          { to: "/data/canonical", label: "Canonical" },
          { to: "/data/published", label: "Published" },
          { to: "/data/compare", label: "Compare" },
        ],
      },
    ],
  );

  assert.deepEqual(
    sectionProjection(permissionsForOperatorRole("data_operator")),
    [
      {
        id: "workspace",
        heading: "Workspace",
        items: [{ to: "/", label: "Overview" }],
      },
      {
        id: "pipeline",
        heading: "Data pipeline",
        items: [
          { to: "/operations", label: "Status" },
          { to: "/providers", label: "Providers" },
          { to: "/source-configuration", label: "Sources" },
          { to: "/runs", label: "Import Runs" },
          { to: "/background-work", label: "Background Work" },
          { to: "/workers", label: "Workers" },
          { to: "/alerts", label: "Alerts" },
          { to: "/quarantine", label: "Quarantine" },
        ],
      },
      {
        id: "data",
        heading: "Data",
        items: [
          { to: "/data/canonical", label: "Canonical" },
          { to: "/data/published", label: "Published" },
          { to: "/data/compare", label: "Compare" },
        ],
      },
    ],
  );
});

test("the real application route tree preserves current detail and recovery routes", () => {
  const actual = [...registeredRoutePaths(readFileSync(APP_SOURCE_PATH, "utf8"))].sort();
  const expected = [
    ...AUTHORITATIVE_PROTECTED_ROUTES,
    ...AUTHORITATIVE_PUBLIC_ROUTES,
    "/*",
  ].sort();
  assert.deepEqual(actual, expected);
});

test("the obsolete Data API Tester route stays absent", () => {
  const registered = registeredRoutePaths(
    readFileSync(APP_SOURCE_PATH, "utf8"),
  );
  assert.equal(registered.has("/data-api-tester"), false);
  assert.equal(ROUTABLE_PATTERNS.includes("/data-api-tester"), false);
  assert.equal(
    ADMIN_DESTINATIONS.some(
      (destination) => destination.segment === "data-api-tester",
    ),
    false,
  );
  assert.equal(pageTitleForPath("/data-api-tester"), "Not found");
});
