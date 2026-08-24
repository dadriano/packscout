import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AuthSessionResponse,
  CanonicalEntityPage,
  CanonicalProviderSummary,
  OperatorPermission,
} from "@packscout/contracts";
import { MemoryRouter } from "react-router-dom";
import { ConfirmProvider } from "../providers/confirm.tsx";
import { SessionProvider } from "../providers/session.tsx";
import { ToastProvider } from "../providers/toast.tsx";
import {
  cleanupPage,
  findButton,
  jsonResponse,
  pageText,
  renderPage,
  settlePage,
  stubFetch,
} from "../testing/react-page-test.tsx";
import { CanonicalDataPage } from "./CanonicalDataPage.tsx";

const inspector: readonly OperatorPermission[] = [
  "providers:view",
  "data_inspection:view",
];
const withoutInspection: readonly OperatorPermission[] = ["providers:view"];

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
      role: "data_operator",
    },
    permissions: [...permissions],
    csrfToken: "csrf-test-token",
  };
}

function route(
  permissions: readonly OperatorPermission[] = inspector,
  entry = "/data/canonical?provider=courtyard&kind=pack",
) {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <SessionProvider initialSession={session(permissions)}>
          <MemoryRouter initialEntries={[entry]}>
            <CanonicalDataPage />
          </MemoryRouter>
        </SessionProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}

const PROVIDERS = {
  providers: [
    { platformKey: "courtyard", displayName: "Courtyard", state: "active" },
    { platformKey: "phygitals", displayName: "Phygitals", state: "active" },
  ],
};

/** One bounded and one exact count, so both renderings are exercised. */
const SUMMARY: CanonicalProviderSummary = {
  platformKey: "courtyard",
  kinds: [
    {
      recordKind: "pack",
      count: 50_000,
      precision: "at_least",
      oldestCollectedAt: "2026-01-02T00:00:00.000Z",
      newestCollectedAt: "2026-08-20T00:00:00.000Z",
      oldestAcceptedAt: "2026-01-02T00:05:00.000Z",
      newestAcceptedAt: "2026-08-20T00:05:00.000Z",
    },
    {
      recordKind: "catalog_asset",
      count: 41,
      precision: "exact",
      oldestCollectedAt: "2026-02-02T00:00:00.000Z",
      newestCollectedAt: "2026-08-19T00:00:00.000Z",
      oldestAcceptedAt: "2026-02-02T00:05:00.000Z",
      newestAcceptedAt: "2026-08-19T00:05:00.000Z",
    },
  ],
};

const PAGE: CanonicalEntityPage = {
  items: [
    {
      entityId: "e-1",
      platformKey: "courtyard",
      recordKind: "pack",
      externalId: "courtyard-pack-0001",
      revisionNumber: 4,
      sourceUpdatedAt: "2026-08-20T00:00:00.000Z",
      sourceCollectedAt: "2026-08-20T00:01:00.000Z",
      acceptedAt: "2026-08-20T00:02:00.000Z",
    },
  ],
  nextCursor: "cursor-2",
};

function routeFetch(
  overrides: Record<string, () => Response> = {},
): (request: { input: RequestInfo | URL }) => Response {
  return (request: { input: RequestInfo | URL }) => {
    const input = String(request.input);
    for (const [fragment, respond] of Object.entries(overrides)) {
      if (input.includes(fragment)) return respond();
    }
    if (input.includes("/canonical/providers/courtyard/summary")) {
      return jsonResponse(SUMMARY);
    }
    if (input.includes("/canonical/providers/courtyard/entities")) {
      return jsonResponse(PAGE);
    }
    if (input.includes("/canonical/providers")) return jsonResponse(PROVIDERS);
    return jsonResponse({});
  };
}

test("an operator without the permission gets the restricted treatment", async (t) => {
  stubFetch(t, routeFetch());
  const page = await renderPage(route(withoutInspection));
  cleanupPage(t, page);
  await settlePage();

  const text = pageText(page);
  assert.match(text, /does not include permission to inspect pipeline data/i);
  assert.doesNotMatch(text, /Records by kind/i);
});

test("a bounded count renders as a floor and an exact count does not", async (t) => {
  stubFetch(t, routeFetch());
  const page = await renderPage(route());
  cleanupPage(t, page);
  await settlePage();

  const text = pageText(page);
  // The floor is stated on the card itself, not hidden in a tooltip.
  assert.match(text, /50,000\+/);
  assert.match(text, /counting stopped at the server bound/i);
  assert.match(text, /Exact count/);
});

test("records list for the selected provider and kind", async (t) => {
  stubFetch(t, routeFetch());
  const page = await renderPage(route());
  cleanupPage(t, page);
  await settlePage();

  assert.match(pageText(page), /courtyard-pack-0001/);
  assert.match(pageText(page), /Revision 4/);
});

test("opening a record shows its content, hashes, and provenance", async (t) => {
  stubFetch(
    t,
    routeFetch({
      "/entities/pack/courtyard-pack-0001": () =>
        jsonResponse({
          ...PAGE.items[0],
          content: { name: "Series One Pack" },
          contentHash: "abc123",
          provenanceHash: "def456",
          provenance: {
            sourceRecordId: "source-1",
            importRunId: "run-1",
            mapperKey: "courtyard-catalog",
            mapperVersion: "3",
            adapterKey: "dataforrest-events-v1",
            additional: {},
          },
          relationships: [],
        }),
    }),
  );
  const page = await renderPage(route());
  cleanupPage(t, page);
  await settlePage();

  const open = findButton(page, "courtyard-pack-0001");
  open.click();
  await settlePage();

  const text = pageText(page);
  assert.match(text, /Series One Pack/);
  assert.match(text, /abc123/);
  assert.match(text, /courtyard-catalog/);
});

test("an empty result reads as empty and a failed read reads as failed", async (t) => {
  stubFetch(
    t,
    routeFetch({
      "/canonical/providers/courtyard/entities": () =>
        jsonResponse({ items: [], nextCursor: null }),
    }),
  );
  const empty = await renderPage(route());
  cleanupPage(t, empty);
  await settlePage();
  assert.match(pageText(empty), /No packs for this provider/i);
  assert.doesNotMatch(pageText(empty), /could not be loaded/i);
});

test("a failed record read keeps the summary on screen", async (t) => {
  stubFetch(
    t,
    routeFetch({
      "/canonical/providers/courtyard/entities": () =>
        jsonResponse({ error: "boom", code: "CANONICAL_STORE_UNAVAILABLE" }, 503),
    }),
  );
  const page = await renderPage(route());
  cleanupPage(t, page);
  await settlePage();

  const text = pageText(page);
  assert.match(text, /could not be loaded/i);
  // Prior safe results stay visible: the summary read succeeded and must not
  // be blanked because a sibling read failed.
  assert.match(text, /Records by kind/i);
});

test("no providers configured reads as its own state", async (t) => {
  stubFetch(
    t,
    routeFetch({ "/canonical/providers": () => jsonResponse({ providers: [] }) }),
  );
  const page = await renderPage(route(inspector, "/data/canonical"));
  cleanupPage(t, page);
  await settlePage();

  assert.match(pageText(page), /No providers are configured yet/i);
});
