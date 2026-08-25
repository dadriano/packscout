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
  changeControl,
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
      collectedExtremaComplete: false,
    },
    {
      recordKind: "catalog_asset",
      count: 41,
      precision: "exact",
      oldestCollectedAt: "2026-02-02T00:00:00.000Z",
      newestCollectedAt: "2026-08-19T00:00:00.000Z",
      oldestAcceptedAt: "2026-02-02T00:05:00.000Z",
      newestAcceptedAt: "2026-08-19T00:05:00.000Z",
      collectedExtremaComplete: true,
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
  page: 1,
  pageSize: 25,
  hasMore: true,
  depthCapped: false,
  direction: "asc",
};

function routeFetch(
  overrides: Record<string, () => Response> = {},
): (request: { input: RequestInfo | URL }) => Response {
  return (request: { input: RequestInfo | URL }) => {
    const input = String(request.input);
    for (const [fragment, respond] of Object.entries(overrides)) {
      if (input.includes(fragment)) return respond();
    }
    if (input.includes("/summary")) return jsonResponse(SUMMARY);
    if (input.includes("/entities")) return jsonResponse(PAGE);
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

test("a bounded count reads as a floor wherever it is shown", async (t) => {
  stubFetch(t, routeFetch());
  const page = await renderPage(route());
  cleanupPage(t, page);
  await settlePage();

  const text = pageText(page);
  // The floor travels with the number into the filter options and the range.
  assert.match(text, /50,000\+/);
  // And a floor cannot be divided into pages, so the index says why.
  assert.match(text, /page numbers need an exact count/i);
});

test("records list for the selected provider and kind", async (t) => {
  stubFetch(t, routeFetch());
  const page = await renderPage(route());
  cleanupPage(t, page);
  await settlePage();

  assert.match(pageText(page), /courtyard-pack-0001/);
  // The revision is its own column now rather than an inline label.
  const cells = [...page.container.querySelectorAll("tbody td")]
    .map((c) => c.textContent?.trim())
    .slice(1);
  assert.deepEqual(cells.slice(0, 3), ["courtyard-pack-0001", "Packs", "4"]);
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

  const toggle = page.container.querySelector<HTMLButtonElement>(
    ".grid-table__toggle",
  );
  assert.ok(toggle);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  toggle.click();
  await settlePage();

  // The detail renders inside the table, in a row beneath the one it belongs
  // to — not in a panel below the pagination.
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  const detailRow = page.container.querySelector(".grid-table__detail-row");
  assert.ok(detailRow, "an expanded detail row should exist");
  const detailText = detailRow.textContent ?? "";
  assert.match(detailText, /Series One Pack/);
  assert.match(detailText, /abc123/);
  assert.match(detailText, /courtyard-catalog/);

  // The expander controls the row it reveals.
  assert.equal(
    toggle.getAttribute("aria-controls"),
    detailRow.querySelector("td")?.id,
  );
});

test("expanding a second record replaces the first, and re-clicking collapses", async (t) => {
  const twoRows = {
    ...PAGE,
    items: [
      PAGE.items[0]!,
      { ...PAGE.items[0]!, entityId: "e-2", externalId: "courtyard-pack-0002" },
    ],
  };
  stubFetch(t, (request) => {
    const input = String(request.input);
    if (input.includes("/entities/pack/")) {
      const id = input.endsWith("0002") ? "e-2" : "e-1";
      return jsonResponse({
        ...PAGE.items[0],
        entityId: id,
        externalId: id === "e-2" ? "courtyard-pack-0002" : "courtyard-pack-0001",
        content: { name: id === "e-2" ? "Second Pack" : "First Pack" },
        contentHash: "h",
        provenanceHash: "p",
        provenance: null,
        relationships: [],
      });
    }
    if (input.includes("/entities")) return jsonResponse(twoRows);
    return routeFetch()({ input: request.input });
  });

  const page = await renderPage(route());
  cleanupPage(t, page);
  await settlePage();

  const toggles = [
    ...page.container.querySelectorAll<HTMLButtonElement>(".grid-table__toggle"),
  ];
  assert.equal(toggles.length, 2);

  toggles[0]!.click();
  await settlePage();
  assert.equal(
    page.container.querySelectorAll(".grid-table__detail-row").length,
    1,
  );

  toggles[1]!.click();
  await settlePage();
  // Still exactly one open row: expanding another switches rather than stacks.
  assert.equal(
    page.container.querySelectorAll(".grid-table__detail-row").length,
    1,
  );

  toggles[1]!.click();
  await settlePage();
  assert.equal(
    page.container.querySelectorAll(".grid-table__detail-row").length,
    0,
  );
});

test("an empty result reads as empty and a failed read reads as failed", async (t) => {
  stubFetch(
    t,
    routeFetch({
      "/canonical/providers/courtyard/entities": () =>
        jsonResponse({
          items: [],
          page: 1,
          pageSize: 25,
          hasMore: false,
          depthCapped: false,
          direction: "asc",
        }),
    }),
  );
  const empty = await renderPage(route());
  cleanupPage(t, empty);
  await settlePage();
  assert.match(pageText(empty), /No packs for this provider/i);
  assert.doesNotMatch(pageText(empty), /could not be loaded/i);
});

test("a failed record read keeps the filters and their counts on screen", async (t) => {
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
  // Prior safe results stay visible: the summary read succeeded, so the filter
  // options keep their counts rather than being blanked by a sibling failure.
  assert.match(text, /50,000\+/);
  assert.ok(page.container.querySelector("#inspect-kind"));
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

test("a deep-linked page opens directly at that page", async (t) => {
  stubFetch(t, (request) => {
    const input = String(request.input);
    if (input.includes("/entities")) {
      // The server echoes the page it served; the grid must trust that.
      return jsonResponse({ ...PAGE, page: 3 });
    }
    return routeFetch()({ input: request.input });
  });
  const page = await renderPage(
    route(inspector, "/data/canonical?provider=courtyard&kind=pack&page=3"),
  );
  cleanupPage(t, page);
  await settlePage();

  // Page three at 25 per page starts at record 51 — reached in one request.
  assert.match(pageText(page), /51–51 of/);
  const previous = findButton(page, "← Previous");
  assert.equal(previous.disabled, false);
});

test("switching provider never leaves the previous provider's records on screen", async (t) => {
  const requests: string[] = [];
  stubFetch(t, (request) => {
    const input = String(request.input);
    requests.push(input);
    if (input.includes("/phygitals/entities")) {
      // The new scope fails. The old rows must go anyway.
      return jsonResponse(
        { error: "boom", code: "CANONICAL_STORE_UNAVAILABLE" },
        503,
      );
    }
    return routeFetch()({ input: request.input });
  });

  const page = await renderPage(route());
  cleanupPage(t, page);
  await settlePage();
  assert.match(pageText(page), /courtyard-pack-0001/);

  changeControl(page, "inspect-provider", "phygitals");
  await settlePage();

  // Whether or not the new read succeeded, the old provider's record must not
  // still be rendered under the new provider's heading.
  assert.doesNotMatch(pageText(page), /courtyard-pack-0001/);
});

test("collection times that were not computed say so, rather than showing a dash", async (t) => {
  stubFetch(t, routeFetch());
  const page = await renderPage(route());
  cleanupPage(t, page);
  await settlePage();

  // The freshness line sits with the grid now. The pack bucket skipped the
  // collection aggregate, and "not computed" is not "nothing collected".
  assert.match(pageText(page), /collected range not computed at this size/i);
});


test("the grid renders records as rows with column headers", async (t) => {
  stubFetch(t, routeFetch());
  const page = await renderPage(route());
  cleanupPage(t, page);
  await settlePage();

  const headers = [...page.container.querySelectorAll("th")]
    .map((cell) => cell.textContent?.replace(/[▲▼↕]/g, "").trim())
    // The first header is the expander, which is label-only for assistive tech.
    .slice(1);
  assert.deepEqual(headers, [
    "External identifier",
    "Kind",
    "Rev",
    "Provider reported",
    "Collected",
    "Accepted",
  ]);

  const cells = [...page.container.querySelectorAll("tbody td")].map((cell) =>
    cell.textContent?.trim(),
  );
  assert.ok(cells.includes("courtyard-pack-0001"));
  assert.ok(cells.includes("4"));
});

test("the range label uses the kind's own count and its precision", async (t) => {
  stubFetch(t, routeFetch());
  const page = await renderPage(route());
  cleanupPage(t, page);
  await settlePage();

  // The pack bucket is a floor of 50,000, so the range must not imply an exact
  // total it does not have.
  assert.match(pageText(page), /1–1 of 50,000\+/);
});

test("the sorted column is marked and clicking it flips the direction", async (t) => {
  stubFetch(t, routeFetch());
  const page = await renderPage(route());
  cleanupPage(t, page);
  await settlePage();

  const header = page.container.querySelector('th[aria-sort]');
  assert.equal(header?.getAttribute("aria-sort"), "ascending");

  const sortButton = page.container.querySelector<HTMLButtonElement>(
    ".grid-table__sort",
  );
  assert.ok(sortButton);
  sortButton.click();
  await settlePage();

  assert.match(pageText(page), /descending/i);
});

test("record kind is chosen from the filter bar, and the cards are gone", async (t) => {
  stubFetch(t, routeFetch());
  const page = await renderPage(route());
  cleanupPage(t, page);
  await settlePage();

  assert.ok(page.container.querySelector("#inspect-kind"));
  assert.equal(page.container.querySelectorAll(".inspect-summary__card").length, 0);
});


test("an exact count produces a numbered index that can jump", async (t) => {
  const exactSummary: CanonicalProviderSummary = {
    platformKey: "courtyard",
    kinds: [
      {
        ...SUMMARY.kinds[0]!,
        recordKind: "pack",
        count: 500,
        precision: "exact",
        collectedExtremaComplete: true,
      },
    ],
  };
  const asked: string[] = [];
  stubFetch(t, (request) => {
    const input = String(request.input);
    asked.push(input);
    if (input.includes("/summary")) return jsonResponse(exactSummary);
    if (input.includes("/entities")) return jsonResponse(PAGE);
    return jsonResponse(PROVIDERS);
  });
  const page = await renderPage(route());
  cleanupPage(t, page);
  await settlePage();

  // 500 records at 25 per page is 20 pages, so numbers are offered.
  const numbers = [...page.container.querySelectorAll(".grid-pagination__page")]
    .map((button) => button.textContent?.trim());
  assert.ok(numbers.includes("1"));
  assert.ok(numbers.length > 1, "a numbered window should render");

  // Jumping is one request for that page, not a walk.
  const target = [...page.container.querySelectorAll<HTMLButtonElement>(
    ".grid-pagination__page",
  )].find((button) => button.textContent?.trim() === "4");
  assert.ok(target, "page 4 should be directly reachable");
  target.click();
  await settlePage();
  assert.ok(asked.some((url) => url.includes("page=4")));
});

test("a page past the scan bound says so instead of reading as empty", async (t) => {
  stubFetch(t, (request) => {
    const input = String(request.input);
    if (input.includes("/entities")) {
      return jsonResponse({ ...PAGE, page: 4001, depthCapped: true });
    }
    return routeFetch()({ input: request.input });
  });
  const page = await renderPage(
    route(inspector, "/data/canonical?provider=courtyard&kind=pack&page=99999"),
  );
  cleanupPage(t, page);
  await settlePage();

  assert.match(pageText(page), /beyond this surface's scan limit/i);
});
