import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProductUserDirectoryRow } from "@packscout/contracts";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import {
  changeControl,
  cleanupPage,
  deferred,
  findButton,
  jsonResponse,
  pageText,
  renderPage,
  settlePage,
  stubFetch,
  type RecordedRequest,
} from "../testing/react-page-test.tsx";
import { ProductUsersPage } from "./ProductUsersPage.tsx";

const emailUser: ProductUserDirectoryRow = {
  subject: "https://auth.example.test/|did:example:email-user",
  authMethod: "https://auth.example.test",
  email: "ada@example.test",
  walletAddress: "0xWalletAddress0001",
  firstSeenAt: "2026-08-01T09:00:00.000Z",
  lastSeenAt: "2026-08-19T12:00:00.000Z",
  standing: "active",
  savedRepackCount: 3,
  savedCollectibleCount: 1,
};
const opaqueUser: ProductUserDirectoryRow = {
  ...emailUser,
  subject:
    "https://auth.example.test/|did:example:opaque-user-with-a-very-long-token-identifier",
  email: null,
  walletAddress: null,
  standing: "suspended",
  savedRepackCount: 0,
  savedCollectibleCount: 0,
};

function route() {
  return (
    <MemoryRouter initialEntries={["/users"]}>
      <ProductUsersPage />
    </MemoryRouter>
  );
}

function body({ init }: RecordedRequest): Record<string, unknown> {
  return JSON.parse(String(init?.body ?? "{}"));
}

async function search(
  renderer: Awaited<ReturnType<typeof renderPage>>,
  term: string,
): Promise<void> {
  await act(async () => changeControl(renderer, "product-user-search", term));
  await act(async () => {
    const form = renderer.container.querySelector<HTMLFormElement>(
      'form[aria-label="Search product users"]',
    );
    if (!form) throw new Error("The product-user search form was not found.");
    form.dispatchEvent(
      new renderer.dom.window.Event("submit", { bubbles: true, cancelable: true }),
    );
  });
  await settlePage();
}

test("the directory lists sign-ups newest first, including records with no email or wallet", async (context) => {
  const load = deferred<Response>();
  const requests = stubFetch(context, () => load.promise);

  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  assert.match(pageText(renderer), /Loading the user directory/);

  load.resolve(
    jsonResponse({
      items: [emailUser, opaqueUser],
      nextCursor: null,
      searchTruncated: false,
    }),
  );
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /ada@example\.test/);
  assert.match(text, /0xWalletAddress0001/);
  assert.match(text, /Sign-in source/);
  assert.match(text, /Active/);
  assert.match(text, /Suspended/);
  assert.match(text, /3 repacks · 1 collectible/);
  assert.match(text, /0 repacks · 0 collectibles/);
  // The record with neither attribute still renders an identifiable row.
  assert.match(text, /No email or wallet address recorded for this sign-up/);
  assert.match(text, /did:example:opaque/);
  assert.equal(
    renderer.container.querySelectorAll(".admin-ledger__rows article").length,
    2,
  );

  // The listing request carries no personal data in its URL.
  assert.equal(String(requests[0]?.input), "/api/product-users/list");
  assert.equal(requests[0]?.init?.method, "POST");
  assert.deepEqual(body(requests[0] as RecordedRequest), { limit: 20 });
});

test("an empty directory and an empty search read differently", async (context) => {
  const requests = stubFetch(context, (request) =>
    body(request).search === undefined
      ? jsonResponse({
          items: [emailUser],
          nextCursor: null,
          searchTruncated: false,
        })
      : jsonResponse({ items: [], nextCursor: null, searchTruncated: false }),
  );

  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  await search(renderer, "  nobody@example.test  ");
  const noMatch = pageText(renderer);
  assert.match(noMatch, /No users match this search/);
  assert.doesNotMatch(noMatch, /No users have signed up yet/);
  assert.deepEqual(body(requests[1] as RecordedRequest), {
    search: "nobody@example.test",
    limit: 20,
  });

  // Clearing the search returns to the unfiltered ledger.
  await act(async () => findButton(renderer, "Clear search").click());
  await settlePage();
  assert.match(pageText(renderer), /ada@example\.test/);
});

test("a directory with no sign-ups says so plainly", async (context) => {
  stubFetch(context, () =>
    jsonResponse({ items: [], nextCursor: null, searchTruncated: false }),
  );
  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /No users have signed up yet/);
  assert.match(text, /A user appears here the first time they sign in/);
  assert.doesNotMatch(text, /No users match this search/);
});

test("an operator without the view permission gets the access-restricted state", async (context) => {
  stubFetch(context, () =>
    jsonResponse(
      { error: "You do not have permission to perform this action.", code: "FORBIDDEN" },
      403,
    ),
  );
  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /This workspace is limited to administrators/);
  assert.match(text, /permission to view product users/);
  assert.doesNotMatch(text, /Sign-up ledger/);
  assert.doesNotMatch(text, /Search email, wallet address/);
});

test("an unavailable integration degrades to a bounded, non-destructive error", async (context) => {
  stubFetch(context, () =>
    jsonResponse(
      {
        error: "The product-user directory integration is not configured.",
        code: "PRODUCT_USER_DIRECTORY_UNCONFIGURED",
      },
      503,
    ),
  );
  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /The product-user directory is not connected/);
  assert.match(text, /Nothing has been changed/);
  assert.doesNotMatch(text, /Bearer|token|convex/i);
  assert.equal(
    renderer.container.querySelectorAll(".admin-ledger__rows article").length,
    0,
  );
  assert.ok(renderer.container.querySelector('[role="alert"]'));
});

test("paging forward and back replays the directory cursors", async (context) => {
  const requests = stubFetch(context, (request) =>
    body(request).cursor === "cursor-page-two"
      ? jsonResponse({
          items: [opaqueUser],
          nextCursor: null,
          searchTruncated: false,
        })
      : jsonResponse({
          items: [emailUser],
          nextCursor: "cursor-page-two",
          searchTruncated: false,
        }),
  );

  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  await act(async () => findButton(renderer, "Next").click());
  await settlePage();
  assert.match(pageText(renderer), /Page 2/);
  assert.deepEqual(body(requests[1] as RecordedRequest), {
    cursor: "cursor-page-two",
    limit: 20,
  });

  await act(async () => findButton(renderer, "Previous").click());
  await settlePage();
  assert.match(pageText(renderer), /Page 1/);
  assert.deepEqual(body(requests[2] as RecordedRequest), { limit: 20 });
});
