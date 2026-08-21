import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AuthSessionResponse,
  OperatorPermission,
  ProductUserDirectoryRow,
} from "@packscout/contracts";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { ConfirmProvider } from "../providers/confirm.tsx";
import { SessionProvider } from "../providers/session.tsx";
import { ToastProvider } from "../providers/toast.tsx";
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

const administrator: readonly OperatorPermission[] = [
  "product_users:view",
  "product_users:manage",
];
/** A viewer holds the read permission and not the account control. */
const viewer: readonly OperatorPermission[] = ["product_users:view"];

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
      role: permissions.includes("product_users:manage")
        ? "admin"
        : "data_operator",
    },
    permissions: [...permissions],
    csrfToken: "csrf-test-token",
  };
}

function route(permissions: readonly OperatorPermission[] = administrator) {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <SessionProvider initialSession={session(permissions)}>
          <MemoryRouter initialEntries={["/users"]}>
            <ProductUsersPage />
          </MemoryRouter>
        </SessionProvider>
      </ConfirmProvider>
    </ToastProvider>
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

test("suspending from the ledger states the consequence first, then shows the new standing", async (context) => {
  const requests = stubFetch(context, (request) =>
    String(request.input).endsWith("/product-users/standing")
      ? jsonResponse({
          user: { ...emailUser, standing: "suspended" },
          changed: true,
        })
      : jsonResponse({
          items: [emailUser],
          nextCursor: null,
          searchTruncated: false,
        }),
  );

  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  await act(async () => findButton(renderer, "Suspend").click());
  await settlePage();

  // Nothing has happened yet: the administrator is being told what will.
  assert.equal(requests.length, 1);
  const confirmText = pageText(renderer);
  assert.match(confirmText, /Suspend this account\?/);
  assert.match(confirmText, /cannot save or unsave anything/);
  assert.match(confirmText, /Everything they have already saved is kept/);
  assert.match(confirmText, /still browse the public catalogue/);
  assert.match(confirmText, /reinstate them at any time/);
  // A confirmation is a decision, so declining it must also be possible.
  findButton(renderer, "Cancel");

  await act(async () => findButton(renderer, "Suspend account").click());
  await settlePage();

  assert.equal(requests.length, 2);
  assert.equal(String(requests[1]?.input), "/api/product-users/standing");
  assert.equal(requests[1]?.init?.method, "POST");
  assert.deepEqual(body(requests[1] as RecordedRequest), {
    subject: emailUser.subject,
    standing: "suspended",
  });

  // The ledger reflects the standing the backend reported, and the control
  // now offers the reverse — without reloading the listing under the operator.
  const text = pageText(renderer);
  assert.match(text, /Suspended/);
  assert.match(text, /Account suspended\. Everything they saved is kept\./);
  findButton(renderer, "Reinstate");
  assert.equal(requests.length, 2);
});

test("declining the confirmation leaves the account exactly as it was", async (context) => {
  const requests = stubFetch(context, () =>
    jsonResponse({
      items: [emailUser],
      nextCursor: null,
      searchTruncated: false,
    }),
  );
  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  await act(async () => findButton(renderer, "Suspend").click());
  await settlePage();
  await act(async () => findButton(renderer, "Cancel").click());
  await settlePage();

  assert.equal(requests.length, 1);
  assert.doesNotMatch(pageText(renderer), /Suspend this account\?/);
  assert.match(pageText(renderer), /Active/);
  findButton(renderer, "Suspend");
});

test("an operator who cannot manage accounts sees the standing and no control", async (context) => {
  const requests = stubFetch(context, () =>
    jsonResponse({
      items: [emailUser, opaqueUser],
      nextCursor: null,
      searchTruncated: false,
    }),
  );
  const renderer = await renderPage(route(viewer));
  cleanupPage(context, renderer);
  await settlePage();

  const labels = [...renderer.container.querySelectorAll("button")].map(
    (button) => button.textContent?.trim() ?? "",
  );
  assert.deepEqual(
    labels.filter((label) =>
      /suspend|reinstate|delete|remove|purge/i.test(label),
    ),
    [],
  );
  // Standing is still readable; only the ability to change it is absent.
  const text = pageText(renderer);
  assert.match(text, /Active/);
  assert.match(text, /Suspended/);
  assert.equal(requests.length, 1);
});
