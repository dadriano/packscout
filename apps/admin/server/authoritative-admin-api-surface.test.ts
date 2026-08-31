import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript";

type ApiMount = Readonly<{
  path: string;
  target: string;
}>;

const APP_SOURCE_PATH = fileURLToPath(new URL("./app.ts", import.meta.url));

const AUTHORITATIVE_API_MOUNTS: readonly ApiMount[] = [
  { path: "/api", target: "apiNotFound" },
  { path: "/api", target: "createImportOperationsRouter" },
  { path: "/api/auth", target: "createAuthRouter" },
  {
    path: "/api/auth/invitations",
    target: "createOperatorInvitationsRouter",
  },
  {
    path: "/api/auth/password-reset",
    target: "createPasswordResetRouter",
  },
  { path: "/api/background-work", target: "createBackgroundWorkRouter" },
  { path: "/api/beta-allowlist", target: "createBetaAllowlistRouter" },
  { path: "/api/data-inspection", target: "createDataInspectionRouter" },
  { path: "/api/data-providers", target: "createProvidersRouter" },
  { path: "/api/health", target: "createHealthRouter" },
  { path: "/api/messages", target: "createMessagesRouter" },
  {
    path: "/api/operational-alerts",
    target: "createOperationalAlertsRouter",
  },
  {
    path: "/api/operational-health",
    target: "createOperationalHealthRouter",
  },
  { path: "/api/operators", target: "createOperatorsRouter" },
  { path: "/api/product-users", target: "createProductUsersRouter" },
  {
    path: "/api/provider-source-operations",
    target: "createProviderSourceOperationsRouter",
  },
  {
    path: "/api/provider-source-operations",
    target: "sourceAdministrationUnconfigured",
  },
  {
    path: "/api/provider-sources",
    target: "createDistributedProviderRequestSettingsRouter",
  },
  { path: "/api/provider-sources", target: "createProviderSourcesRouter" },
  {
    path: "/api/provider-sources",
    target: "sourceAdministrationUnconfigured",
  },
  { path: "/api/worker-fleet", target: "createWorkerFleetRouter" },
] as const;

function mountedTargetName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isCallExpression(expression)) {
    const callee = expression.expression;
    if (ts.isIdentifier(callee)) return callee.text;
    if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  }
  return null;
}

/**
 * Extract literal Express mount contracts from the TypeScript syntax tree.
 * Formatting, comments, and implementation bodies may change freely; a mount
 * disappears only when the actual `app.use(path, router)` registration does.
 */
function apiMountsFromSource(source: string): readonly ApiMount[] {
  const sourceFile = ts.createSourceFile(
    APP_SOURCE_PATH,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const mounts: ApiMount[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "app" &&
      node.expression.name.text === "use"
    ) {
      const [pathExpression, targetExpression] = node.arguments;
      if (
        pathExpression !== undefined &&
        ts.isStringLiteral(pathExpression) &&
        targetExpression !== undefined
      ) {
        const target = mountedTargetName(targetExpression);
        if (target !== null) mounts.push({ path: pathExpression.text, target });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return mounts;
}

function sortMounts(mounts: readonly ApiMount[]): readonly ApiMount[] {
  return [...mounts].sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.target.localeCompare(right.target),
  );
}

test("the authoritative admin API mount groups remain wired", () => {
  const source = readFileSync(APP_SOURCE_PATH, "utf8");
  assert.deepEqual(
    sortMounts(apiMountsFromSource(source)),
    sortMounts(AUTHORITATIVE_API_MOUNTS),
  );
});
