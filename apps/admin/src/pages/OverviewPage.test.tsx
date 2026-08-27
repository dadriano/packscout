import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AuthSessionResponse,
  OperatorPermission,
} from "@packscout/contracts";
import { MemoryRouter } from "react-router-dom";
import { SessionProvider } from "../providers/session.tsx";
import { ToastProvider } from "../providers/toast.tsx";
import {
  cleanupPage,
  jsonResponse,
  pageText,
  renderPage,
  settlePage,
  stubFetch,
} from "../testing/react-page-test.tsx";
import { OverviewPage } from "./OverviewPage.tsx";

/** Holds `providers:manage`, so provider setup is an action it can take. */
const administrator: readonly OperatorPermission[] = [
  "providers:view",
  "providers:manage",
];
/** The role the authoritative grant gives `providers:view` without manage. */
const dataOperator: readonly OperatorPermission[] = ["providers:view"];

function session(
  permissions: readonly OperatorPermission[],
): AuthSessionResponse {
  return {
    operator: {
      id: "00000000-0000-4000-8000-000000000001",
      email: "operator@packscout.test",
      displayName: "Morgan Scout",
      state: "active",
    },
    membership: {
      organizationId: "00000000-0000-4000-8000-000000000010",
      organizationName: "PackScout",
      role: permissions.includes("providers:manage") ? "admin" : "data_operator",
    },
    permissions: [...permissions],
    csrfToken: "csrf-test-token",
  };
}

function route(permissions: readonly OperatorPermission[] = administrator) {
  return (
    <ToastProvider>
      <SessionProvider initialSession={session(permissions)}>
        <MemoryRouter initialEntries={["/"]}>
          <OverviewPage />
        </MemoryRouter>
      </SessionProvider>
    </ToastProvider>
  );
}

/** Answers the health probe and the provider read with the given providers. */
function stubOverview(
  context: Parameters<typeof stubFetch>[0],
  providerCount: number,
) {
  return stubFetch(context, ({ input }) => {
    if (String(input).includes("/data-providers")) {
      return jsonResponse({
        items: Array.from({ length: providerCount }, (_unused, index) => ({
          id: `00000000-0000-4000-8000-00000000010${index}`,
          displayName: `Provider ${index + 1}`,
        })),
      });
    }
    return jsonResponse({ status: "ok" });
  });
}

test("the overview reports live state and holds no fixed status copy", async (context) => {
  stubOverview(context, 0);
  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /Admin service/);
  assert.match(text, /Providers/);
  // Panels asserting the codebase's own properties rendered permanently green
  // beside a genuinely polled reading. Nothing here may claim a state it has
  // not read.
  assert.doesNotMatch(text, /Guardrails carried forward|Zero accepted drift/);
  assert.doesNotMatch(text, /What the base does not pretend/);
});

test("provider setup directs administrators to Provider Sources", async (context) => {
  stubOverview(context, 0);
  const renderer = await renderPage(route(administrator));
  cleanupPage(context, renderer);
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /None yet/);
  assert.match(text, /Set up your first provider source/);
  const action = renderer.container.querySelector('a[href="/source-configuration"]');
  assert.ok(action, "The setup prompt links to Provider Sources.");
  assert.equal(renderer.container.querySelector('a[href="/providers/new"]'), null);
});

test("provider setup is not offered to a role that cannot create one", async (context) => {
  stubOverview(context, 0);
  const renderer = await renderPage(route(dataOperator));
  cleanupPage(context, renderer);
  await settlePage();

  const text = pageText(renderer);
  // Sending this role to the create form is a dead end: the providers page
  // hides that action from it.
  assert.doesNotMatch(text, /Set up your first provider source/);
  assert.match(text, /No provider sources are configured yet/);
  assert.equal(renderer.container.querySelector('a[href="/providers/new"]'), null);
});

test("setup guidance stops once a provider exists", async (context) => {
  stubOverview(context, 2);
  const renderer = await renderPage(route(administrator));
  cleanupPage(context, renderer);
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /2 configured/);
  assert.doesNotMatch(text, /Set up your first provider source/);
  assert.doesNotMatch(text, /No provider sources are configured yet/);
});

test("a failed provider read reports nothing rather than reporting none", async (context) => {
  stubFetch(context, ({ input }) => {
    if (String(input).includes("/data-providers")) {
      return jsonResponse({ message: "unavailable" }, 503);
    }
    return jsonResponse({ status: "ok" });
  });
  const renderer = await renderPage(route(administrator));
  cleanupPage(context, renderer);
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /Unavailable/);
  // "No providers yet" would be a claim the page cannot support.
  assert.doesNotMatch(text, /None yet/);
  assert.doesNotMatch(text, /Set up your first provider source/);
});
