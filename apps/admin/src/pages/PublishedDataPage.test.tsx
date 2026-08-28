import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import type {
  AuthSessionResponse,
  OperatorPermission,
} from "@packscout/contracts";
import { MemoryRouter } from "react-router-dom";
import { ConfirmProvider } from "../providers/confirm.tsx";
import { SessionProvider } from "../providers/session.tsx";
import { ToastProvider } from "../providers/toast.tsx";
import {
  cleanupPage,
  deferred,
  findButton,
  jsonResponse,
  pageText,
  renderPage,
  settlePage,
  stubFetch,
} from "../testing/react-page-test.tsx";
import { PublishedDataPage } from "./PublishedDataPage.tsx";

const inspector: readonly OperatorPermission[] = [
  "providers:view",
  "data_inspection:view",
];

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
  entry = "/data/published?provider=clutchpacks&kind=repacks",
  permissions: readonly OperatorPermission[] = inspector,
) {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <SessionProvider initialSession={session(permissions)}>
          <MemoryRouter initialEntries={[entry]}>
            <PublishedDataPage />
          </MemoryRouter>
        </SessionProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}

const PROVIDERS = {
  providers: [
    {
      platformKey: "clutchpacks",
      displayName: "ClutchPacks",
      state: "active",
    },
    { platformKey: "courtyard", displayName: "Courtyard", state: "active" },
  ],
};

const ACTIVE_RELEASE = {
  status: "active",
  manifestPublicReleaseId: "catalog-manifest-2026-08-27",
  referenceFingerprint: "a".repeat(64),
  release: {
    publicProviderReleaseId: "clutchpacks-release-2026-08-27",
    platformKey: "clutchpacks",
    lifecycle: "complete",
    dataAsOf: "2026-08-27T10:00:00.000Z",
    providerReleaseFingerprint: "b".repeat(64),
    contentHash: "c".repeat(64),
    entityHashes: {
      vendors: "d".repeat(64),
      categories: "e".repeat(64),
      collectibles: "f".repeat(64),
      repacks: "1".repeat(64),
      repack_chases: "2".repeat(64),
      search_shards: "3".repeat(64),
    },
    counts: {
      vendors: 1,
      categories: 12,
      collectibles: 6_312,
      repacks: 17,
      repackChases: 19_093,
      searchShards: 2,
    },
    batchCount: 4,
    batchChainHash: "4".repeat(64),
    createdAt: "2026-08-27T09:50:00.000Z",
    completedAt: "2026-08-27T10:05:00.000Z",
    completionOperationId: "publish-clutchpacks-001",
  },
} as const;

const FIRST_PAGE = {
  status: "ok",
  items: [
    {
      publicEntityId: "clutchpacks-repack-one",
      detail: {
        publicRepackId: "clutchpacks-repack-one",
        name: "Golden Repack",
        vendorKey: "clutchpacks",
        availability: "available",
      },
    },
  ],
  isDone: false,
  continueCursor: "opaque next cursor",
} as const;

function publishedFetch(
  overrides: Readonly<Record<string, () => Response>> = {},
) {
  return (request: { input: RequestInfo | URL }): Response => {
    const input = String(request.input);
    for (const [fragment, respond] of Object.entries(overrides)) {
      if (input.includes(fragment)) return respond();
    }
    if (input.includes("/canonical/providers")) return jsonResponse(PROVIDERS);
    if (input.includes("/active-release")) return jsonResponse(ACTIVE_RELEASE);
    if (input.includes("/chase-reconciliation")) {
      return jsonResponse({
        status: "ok",
        publicRepackId: "clutchpacks-repack-one",
        expectedChaseCount: 3,
        acceptedChaseCount: 3,
        complete: true,
      });
    }
    if (input.includes("/entities/repacks/")) {
      return jsonResponse({
        status: "ok",
        publicEntityId: "clutchpacks-repack-one",
        detail: {
          publicRepackId: "clutchpacks-repack-one",
          name: "Golden Repack",
          description: "Stored detail evidence",
        },
      });
    }
    if (input.includes("/entities")) return jsonResponse(FIRST_PAGE);
    return jsonResponse({});
  };
}

async function settlePublished(): Promise<void> {
  await settlePage();
  await settlePage();
  await settlePage();
}

async function clickAndSettle(button: HTMLButtonElement): Promise<void> {
  await React.act(async () => button.click());
  await settlePublished();
}

test("an operator without inspection permission never starts a published read", async (t) => {
  const requests = stubFetch(t, publishedFetch());
  const page = await renderPage(route(undefined, ["providers:view"]));
  cleanupPage(t, page);
  await settlePublished();

  assert.match(pageText(page), /does not include permission to inspect pipeline data/i);
  assert.equal(requests.length, 0);
});

test("the active release shows lifecycle, identities, hashes, counts, and all browsable kinds", async (t) => {
  stubFetch(t, publishedFetch());
  const page = await renderPage(route());
  cleanupPage(t, page);
  await settlePublished();

  const text = pageText(page);
  assert.match(text, /clutchpacks-release-2026-08-27/);
  assert.match(text, /catalog-manifest-2026-08-27/);
  assert.match(text, /19,093/);
  assert.match(text, /Provider release fingerprint/i);
  assert.match(text, /pipeline-only/i);
  const kinds = [...page.container.querySelectorAll("#published-kind option")]
    .map((option) => option.getAttribute("value"));
  assert.deepEqual(kinds, ["vendors", "categories", "repacks", "collectibles"]);
});

for (const scenario of [
  {
    name: "no active manifest",
    value: { status: "no_active_manifest" },
    expected: /no active catalog manifest/i,
  },
  {
    name: "platform absent from manifest",
    value: {
      status: "platform_not_referenced",
      manifestPublicReleaseId: "catalog-manifest-other",
    },
    expected: /does not reference this platform/i,
  },
  {
    name: "referenced release missing",
    value: {
      status: "release_missing",
      manifestPublicReleaseId: "catalog-manifest-broken",
      publicProviderReleaseId: "provider-release-missing",
    },
    expected: /points to a release the backend cannot read/i,
  },
] as const) {
  test(`${scenario.name} is distinct from a zero-record release`, async (t) => {
    stubFetch(
      t,
      publishedFetch({
        "/active-release": () => jsonResponse(scenario.value),
      }),
    );
    const page = await renderPage(route());
    cleanupPage(t, page);
    await settlePublished();

    assert.match(pageText(page), scenario.expected);
    assert.doesNotMatch(pageText(page), /0 records on this page/i);
    assert.equal(page.container.querySelector(".grid-table"), null);
  });
}

test("a non-complete release is inspectable but carries an explicit lifecycle warning", async (t) => {
  stubFetch(
    t,
    publishedFetch({
      "/active-release": () =>
        jsonResponse({
          ...ACTIVE_RELEASE,
          release: { ...ACTIVE_RELEASE.release, lifecycle: "staging" },
        }),
    }),
  );
  const page = await renderPage(route());
  cleanupPage(t, page);
  await settlePublished();

  const text = pageText(page);
  assert.match(text, /references a staging release/i);
  assert.match(text, /Golden Repack/);
});

test("backend unavailability has an operator-facing danger state", async (t) => {
  stubFetch(
    t,
    publishedFetch({
      "/active-release": () =>
        jsonResponse({ error: "offline", code: "PUBLISHED_UNAVAILABLE" }, 503),
    }),
  );
  const unavailable = await renderPage(route());
  cleanupPage(t, unavailable);
  await settlePublished();
  assert.match(pageText(unavailable), /product backend is temporarily unreachable/i);
  assert.equal(unavailable.container.querySelector(".admin-notice"), null);
  assert.ok(
    unavailable.container
      .querySelector('[role="alert"]')
      ?.classList.contains("admin-note"),
  );
});

test("forbidden reads have a distinct operator-facing danger state", async (t) => {
  stubFetch(
    t,
    publishedFetch({
      "/active-release": () =>
        jsonResponse({ error: "forbidden", code: "FORBIDDEN" }, 403),
    }),
  );
  const forbidden = await renderPage(route());
  cleanupPage(t, forbidden);
  await settlePublished();
  assert.match(pageText(forbidden), /no longer includes permission/i);
  assert.ok(
    forbidden.container
      .querySelector('[role="alert"]')
      ?.classList.contains("admin-note-danger"),
  );
});

test("an invalid deep-linked cursor offers a truthful return to page one", async (t) => {
  const requests = stubFetch(
    t,
    publishedFetch({
      "/entities?": () =>
        jsonResponse(
          {
            error: "bad cursor",
            code: "PUBLISHED_CATALOG_REQUEST_INVALID",
          },
          400,
        ),
    }),
  );
  const page = await renderPage(
    route("/data/published?provider=clutchpacks&kind=repacks&cursor=expired&page=8"),
  );
  cleanupPage(t, page);
  await settlePublished();

  assert.match(pageText(page), /cursor is invalid/i);
  await clickAndSettle(findButton(page, "Return to first page"));
  assert.ok(
    requests.some((request) => {
      const url = new URL(String(request.input), "https://admin.test");
      return url.pathname.endsWith("/entities") && !url.searchParams.has("cursor");
    }),
  );
});

test("an empty published kind is not described as an unavailable read", async (t) => {
  stubFetch(
    t,
    publishedFetch({
      "/entities?": () =>
        jsonResponse({
          status: "ok",
          items: [],
          isDone: true,
          continueCursor: "",
        }),
    }),
  );
  const page = await renderPage(route());
  cleanupPage(t, page);
  await settlePublished();

  assert.match(pageText(page), /contains no repacks/i);
  assert.doesNotMatch(pageText(page), /could not be refreshed/i);
});

test("opening a repack shows its stored document and parent chase reconciliation", async (t) => {
  stubFetch(t, publishedFetch());
  const page = await renderPage(route());
  cleanupPage(t, page);
  await settlePublished();

  const toggle = page.container.querySelector<HTMLButtonElement>(
    ".grid-table__toggle",
  );
  assert.ok(toggle);
  await clickAndSettle(toggle);

  const detail = page.container.querySelector(".grid-table__detail-row");
  assert.ok(detail);
  assert.match(detail.textContent ?? "", /Stored detail evidence/);
  assert.match(detail.textContent ?? "", /Expected\s*3Accepted\s*3Result\s*complete/i);
  assert.match(detail.textContent ?? "", /not synthetic standalone entities/i);
});

test("a slower prior row read cannot replace the currently expanded document", async (t) => {
  const firstDocument = deferred<Response>();
  stubFetch(t, (request) => {
    const input = String(request.input);
    if (input.includes("/canonical/providers")) return jsonResponse(PROVIDERS);
    if (input.includes("/active-release")) return jsonResponse(ACTIVE_RELEASE);
    if (input.includes("/entities?")) {
      return jsonResponse({
        status: "ok",
        items: [
          {
            publicEntityId: "clutchpacks-repack-one",
            detail: {
              publicRepackId: "clutchpacks-repack-one",
              name: "Golden Repack",
            },
          },
          {
            publicEntityId: "clutchpacks-repack-two",
            detail: {
              publicRepackId: "clutchpacks-repack-two",
              name: "Silver Repack",
            },
          },
        ],
        isDone: true,
        continueCursor: "",
      });
    }
    if (input.includes("/entities/repacks/clutchpacks-repack-one")) {
      return firstDocument.promise;
    }
    if (input.includes("/entities/repacks/clutchpacks-repack-two")) {
      return jsonResponse({
        status: "ok",
        publicEntityId: "clutchpacks-repack-two",
        detail: {
          publicRepackId: "clutchpacks-repack-two",
          name: "Silver stored detail",
        },
      });
    }
    if (input.includes("/chase-reconciliation")) {
      const publicRepackId = input.includes("clutchpacks-repack-two")
        ? "clutchpacks-repack-two"
        : "clutchpacks-repack-one";
      return jsonResponse({
        status: "ok",
        publicRepackId,
        expectedChaseCount: 3,
        acceptedChaseCount: 3,
        complete: true,
      });
    }
    return jsonResponse({});
  });
  const page = await renderPage(route());
  cleanupPage(t, page);
  await settlePublished();

  const toggles = [
    ...page.container.querySelectorAll<HTMLButtonElement>(
      ".grid-table__toggle",
    ),
  ];
  assert.equal(toggles.length, 2);
  await clickAndSettle(toggles[0]);
  await clickAndSettle(toggles[1]);

  let detail = page.container.querySelector(".grid-table__detail-row");
  assert.ok(detail);
  assert.match(detail.textContent ?? "", /Silver stored detail/);

  firstDocument.resolve(
    jsonResponse({
      status: "ok",
      publicEntityId: "clutchpacks-repack-one",
      detail: {
        publicRepackId: "clutchpacks-repack-one",
        name: "Golden late detail",
      },
    }),
  );
  await settlePublished();

  detail = page.container.querySelector(".grid-table__detail-row");
  assert.ok(detail);
  assert.match(detail.textContent ?? "", /Silver stored detail/);
  assert.doesNotMatch(detail.textContent ?? "", /Golden late detail/);
  assert.doesNotMatch(detail.textContent ?? "", /Loading document/);
});

test("cursor paging deep-links forward and returns without inventing page numbers", async (t) => {
  const requests = stubFetch(t, (request) => {
    const input = String(request.input);
    if (input.includes("cursor=opaque")) {
      return jsonResponse({
        status: "ok",
        items: [
          {
            publicEntityId: "clutchpacks-repack-two",
            detail: { publicRepackId: "clutchpacks-repack-two", name: "Silver Repack" },
          },
        ],
        isDone: true,
        continueCursor: "",
      });
    }
    return publishedFetch()(request);
  });
  const page = await renderPage(route());
  cleanupPage(t, page);
  await settlePublished();

  await clickAndSettle(findButton(page, "Next →"));
  assert.match(pageText(page), /Page 2/);
  assert.match(pageText(page), /Silver Repack/);
  assert.ok(
    requests.some((request) => {
      const url = new URL(String(request.input), "https://admin.test");
      return url.searchParams.get("cursor") === "opaque next cursor";
    }),
  );

  await clickAndSettle(findButton(page, "← Previous"));
  assert.match(pageText(page), /Page 1/);
  assert.match(pageText(page), /Golden Repack/);
});

test("a valid deep-linked cursor preserves its page while refusing a fake previous hop", async (t) => {
  const requests = stubFetch(t, publishedFetch());
  const page = await renderPage(
    route("/data/published?provider=clutchpacks&kind=repacks&cursor=shared-link&page=8"),
  );
  cleanupPage(t, page);
  await settlePublished();

  assert.match(pageText(page), /Page 8/);
  assert.ok(
    requests.some((request) => {
      const url = new URL(String(request.input), "https://admin.test");
      return url.searchParams.get("cursor") === "shared-link";
    }),
  );
  assert.equal(findButton(page, "← Previous").disabled, true);
  assert.equal(findButton(page, "« First").disabled, false);
});

test("a page number without its opaque cursor is truthfully treated as page one", async (t) => {
  const requests = stubFetch(t, publishedFetch());
  const page = await renderPage(
    route("/data/published?provider=clutchpacks&kind=repacks&page=8"),
  );
  cleanupPage(t, page);
  await settlePublished();

  assert.match(pageText(page), /Page 1/);
  assert.doesNotMatch(pageText(page), /Page 8/);
  assert.ok(
    requests.some((request) => {
      const url = new URL(String(request.input), "https://admin.test");
      return url.pathname.endsWith("/entities") && !url.searchParams.has("cursor");
    }),
  );
  assert.equal(findButton(page, "← Previous").disabled, true);
  assert.equal(findButton(page, "« First").disabled, true);
});

test("an opaque cursor without its page number is truthfully treated as page one", async (t) => {
  const requests = stubFetch(t, publishedFetch());
  const page = await renderPage(
    route("/data/published?provider=clutchpacks&kind=repacks&cursor=orphaned"),
  );
  cleanupPage(t, page);
  await settlePublished();

  assert.match(pageText(page), /Page 1/);
  assert.ok(
    requests.some((request) => {
      const url = new URL(String(request.input), "https://admin.test");
      return url.pathname.endsWith("/entities") && !url.searchParams.has("cursor");
    }),
  );
  assert.equal(findButton(page, "← Previous").disabled, true);
});

test("a provider outside the shared roster never reaches a published route", async (t) => {
  const requests = stubFetch(t, publishedFetch());
  const page = await renderPage(
    route("/data/published?provider=unconfigured&kind=repacks"),
  );
  cleanupPage(t, page);
  await settlePublished();

  assert.match(pageText(page), /not in this workspace roster/i);
  assert.equal(
    requests.some((request) => String(request.input).includes("/published/")),
    false,
  );
});

test("a failed refresh keeps prior same-release rows visible", async (t) => {
  let activeReads = 0;
  stubFetch(t, (request) => {
    const input = String(request.input);
    if (input.includes("/active-release")) {
      activeReads += 1;
      if (activeReads > 1) {
        return jsonResponse({ error: "offline", code: "PUBLISHED_UNAVAILABLE" }, 503);
      }
    }
    return publishedFetch()(request);
  });
  const page = await renderPage(route());
  cleanupPage(t, page);
  await settlePublished();
  assert.match(pageText(page), /Golden Repack/);

  await clickAndSettle(findButton(page, "Refresh read"));
  const text = pageText(page);
  assert.match(text, /product backend is temporarily unreachable/i);
  assert.match(text, /Golden Repack/);
});
