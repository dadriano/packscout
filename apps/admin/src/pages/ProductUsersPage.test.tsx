import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AuthSessionResponse,
  OperatorPermission,
  ProductUserDirectoryRow,
} from "@packscout/contracts";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import {
  forgetProductUserHandles,
  resolveProductUserHandle,
} from "../components/product-users/subject-handle.ts";
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
  access: {
    state: "approved",
    decidedBy: "allowlist",
    decidedAt: "2026-08-01T09:00:05.000Z",
  },
  savedRepackCount: 3,
  savedCollectibleCount: 1,
};
/** Suspended and waiting at once: the two dimensions must never read as one. */
const opaqueUser: ProductUserDirectoryRow = {
  ...emailUser,
  subject:
    "https://auth.example.test/|did:example:opaque-user-with-a-very-long-token-identifier",
  email: null,
  walletAddress: null,
  standing: "suspended",
  access: {
    state: "awaiting_review",
    decidedBy: "default",
    decidedAt: "2026-08-02T08:00:00.000Z",
  },
  savedRepackCount: 0,
  savedCollectibleCount: 0,
};
/** The oldest waiting identity, at the front of the review queue. */
const waitingUser: ProductUserDirectoryRow = {
  ...emailUser,
  subject: "https://auth.example.test/|did:example:waiting-user",
  email: "waiting@example.test",
  walletAddress: null,
  access: {
    state: "awaiting_review",
    decidedBy: "default",
    decidedAt: "2026-07-20T09:00:00.000Z",
  },
};

const administrator: readonly OperatorPermission[] = [
  "product_users:view",
  "product_users:manage",
];
/** A viewer holds the read permission and not the account controls. */
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

/**
 * The page reads more than one endpoint — the listing or queue, and the
 * awaiting count for the header — so stubs dispatch on the request path and
 * assertions pick the requests they are about instead of assuming an order.
 */
interface DirectoryStubs {
  readonly list?: (request: RecordedRequest) => Response | Promise<Response>;
  readonly queue?: (request: RecordedRequest) => Response | Promise<Response>;
  readonly count?: (request: RecordedRequest) => Response | Promise<Response>;
  readonly decide?: (request: RecordedRequest) => Response | Promise<Response>;
  readonly standing?: (request: RecordedRequest) => Response | Promise<Response>;
}

function pathOf({ input }: RecordedRequest): string {
  return String(input);
}

function isDecision(path: string): boolean {
  return /\/product-users\/access\/(approve|decline|revoke)$/.test(path);
}

function directoryFetch(
  context: Parameters<typeof stubFetch>[0],
  stubs: DirectoryStubs = {},
) {
  const requests = stubFetch(context, (request) => {
    const path = pathOf(request);
    if (path.endsWith("/product-users/access/queue-count")) {
      return (
        stubs.count?.(request) ?? jsonResponse({ count: 1, truncated: false })
      );
    }
    if (path.endsWith("/product-users/access/queue")) {
      return (
        stubs.queue?.(request) ??
        jsonResponse({
          items: [waitingUser, opaqueUser],
          nextCursor: null,
          queueTruncated: false,
        })
      );
    }
    if (isDecision(path)) {
      if (stubs.decide) return stubs.decide(request);
      throw new Error(`Unexpected decision request: ${path}`);
    }
    if (path.endsWith("/product-users/standing")) {
      if (stubs.standing) return stubs.standing(request);
      throw new Error(`Unexpected standing request: ${path}`);
    }
    return (
      stubs.list?.(request) ??
      jsonResponse({
        items: [emailUser, opaqueUser],
        nextCursor: null,
        searchTruncated: false,
      })
    );
  });
  return {
    requests,
    listRequests: () =>
      requests.filter((request) => pathOf(request).endsWith("/product-users/list")),
    queueRequests: () =>
      requests.filter((request) =>
        pathOf(request).endsWith("/product-users/access/queue"),
      ),
    countRequests: () =>
      requests.filter((request) =>
        pathOf(request).endsWith("/product-users/access/queue-count"),
      ),
    decisionRequests: () =>
      requests.filter((request) => isDecision(pathOf(request))),
  };
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

async function openQueue(
  renderer: Awaited<ReturnType<typeof renderPage>>,
): Promise<void> {
  const toggle = [...renderer.container.querySelectorAll("button")].find(
    (button) => button.textContent?.startsWith("Review queue"),
  );
  if (!toggle) throw new Error("The review queue toggle was not found.");
  await act(async () => toggle.click());
  await settlePage();
}

test("the directory lists sign-ups newest first, including records with no email or wallet", async (context) => {
  const load = deferred<Response>();
  const { listRequests } = directoryFetch(context, { list: () => load.promise });

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
  const [listRequest] = listRequests();
  assert.equal(String(listRequest?.input), "/api/product-users/list");
  assert.equal(listRequest?.init?.method, "POST");
  assert.deepEqual(body(listRequest as RecordedRequest), { limit: 20 });
});

test("access state and standing are separate badges that can never read as one", async (context) => {
  directoryFetch(context);
  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  const rows = [...renderer.container.querySelectorAll(".admin-ledger__rows article")];
  assert.equal(rows.length, 2);

  // The admitted, active account: Approved (ready) beside Active (ready).
  const admittedBadges = [...(rows[0]?.querySelectorAll(".admin-status") ?? [])];
  assert.deepEqual(
    admittedBadges.map((badge) => badge.textContent?.trim()),
    ["Approved", "Active"],
  );

  // The waiting, suspended account: the waiting badge is the pending tone,
  // never the danger tone the suspension badge uses beside it.
  const waitingBadges = [...(rows[1]?.querySelectorAll(".admin-status") ?? [])];
  assert.deepEqual(
    waitingBadges.map((badge) => badge.textContent?.trim()),
    ["Awaiting review", "Suspended"],
  );
  assert.ok(waitingBadges[0]?.classList.contains("admin-status--pending"));
  assert.ok(!waitingBadges[0]?.classList.contains("admin-status--danger"));
  assert.ok(waitingBadges[1]?.classList.contains("admin-status--danger"));

  // Provenance says how each decision came to be, with its date.
  const text = pageText(renderer);
  assert.match(text, /Beta access/);
  assert.match(text, /Admitted automatically by the allowlist/);
  assert.match(text, /Awaiting a first decision/);
});

/**
 * The subject key is issuer-qualified personal data, and a URL is written down
 * in browser history, access logs, same-origin referrers, and the sign-in
 * returnTo. No rendered link may therefore carry one, in any encoding, while
 * the row must still open exactly the user it names.
 */
test("no rendered link carries a subject key, and the opaque link still opens the user", async (context) => {
  forgetProductUserHandles();
  context.after(() => forgetProductUserHandles());
  directoryFetch(context);
  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  const links = [...renderer.container.querySelectorAll("a")].map(
    (anchor) => anchor.getAttribute("href") ?? "",
  );
  assert.equal(links.length, 2, "each row links to its own detail view");

  for (const href of links) {
    // Raw, percent-encoded, and double-encoded forms are all checked, so a
    // link cannot pass by being escaped differently.
    for (const rendering of [href, decodeURIComponent(href)]) {
      for (const row of [emailUser, opaqueUser]) {
        assert.ok(
          !rendering.includes(row.subject),
          `link ${href} carries a subject key`,
        );
        assert.ok(!rendering.includes(encodeURIComponent(row.subject)));
      }
      // Nor any fragment of an identity: issuer, scheme, or wallet address.
      assert.doesNotMatch(rendering, /did:|auth\.example\.test|0xWallet|@/);
    }
    assert.match(href, /^\/users\/[0-9a-f]{32}$/);
  }

  // The handle is opaque to everyone but this tab, where it still resolves to
  // exactly the row that issued it.
  assert.deepEqual(
    links.map((href) => resolveProductUserHandle(href.slice("/users/".length))),
    [emailUser.subject, opaqueUser.subject],
  );
  // Two people never share a handle, and a handle is not derived from anyone.
  assert.notEqual(links[0], links[1]);
});

test("an empty directory and an empty search read differently", async (context) => {
  const { listRequests } = directoryFetch(context, {
    list: (request) =>
      body(request).search === undefined
        ? jsonResponse({
            items: [emailUser],
            nextCursor: null,
            searchTruncated: false,
          })
        : jsonResponse({ items: [], nextCursor: null, searchTruncated: false }),
  });

  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  await search(renderer, "  nobody@example.test  ");
  const noMatch = pageText(renderer);
  assert.match(noMatch, /No users match this search/);
  assert.doesNotMatch(noMatch, /No users have signed up yet/);
  assert.deepEqual(body(listRequests()[1] as RecordedRequest), {
    search: "nobody@example.test",
    limit: 20,
  });

  // Clearing the search returns to the unfiltered ledger.
  await act(async () => findButton(renderer, "Clear search").click());
  await settlePage();
  assert.match(pageText(renderer), /ada@example\.test/);
});

test("a directory with no sign-ups says so plainly", async (context) => {
  directoryFetch(context, {
    list: () =>
      jsonResponse({ items: [], nextCursor: null, searchTruncated: false }),
    count: () => jsonResponse({ count: 0, truncated: false }),
  });
  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /No users have signed up yet/);
  assert.match(text, /A user appears here the first time they sign in/);
  assert.doesNotMatch(text, /No users match this search/);
});

test("an operator without the view permission gets the access-restricted state", async (context) => {
  const forbiddenResponse = () =>
    jsonResponse(
      { error: "You do not have permission to perform this action.", code: "FORBIDDEN" },
      403,
    );
  directoryFetch(context, { list: forbiddenResponse, count: forbiddenResponse });
  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /This workspace is limited to administrators/);
  assert.match(text, /permission to view product users/);
  assert.doesNotMatch(text, /Sign-up ledger/);
  assert.doesNotMatch(text, /Search email, wallet address/);
  assert.doesNotMatch(text, /awaiting review/);
});

test("an unavailable integration degrades to a bounded, non-destructive error", async (context) => {
  const unavailable = () =>
    jsonResponse(
      {
        error: "The product-user directory integration is not configured.",
        code: "PRODUCT_USER_DIRECTORY_UNCONFIGURED",
      },
      503,
    );
  directoryFetch(context, { list: unavailable, count: unavailable });
  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /The product-user directory is not connected/);
  assert.match(text, /Nothing has been changed/);
  assert.doesNotMatch(text, /Bearer|token|convex/i);
  // The header shows no waiting count rather than a number it cannot know.
  assert.doesNotMatch(text, /awaiting review/);
  assert.equal(
    renderer.container.querySelectorAll(".admin-ledger__rows article").length,
    0,
  );
  assert.ok(renderer.container.querySelector('[role="alert"]'));
});

test("paging forward and back replays the directory cursors", async (context) => {
  const { listRequests } = directoryFetch(context, {
    list: (request) =>
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
  });

  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  await act(async () => findButton(renderer, "Next").click());
  await settlePage();
  assert.match(pageText(renderer), /Page 2/);
  assert.deepEqual(body(listRequests()[1] as RecordedRequest), {
    cursor: "cursor-page-two",
    limit: 20,
  });

  await act(async () => findButton(renderer, "Previous").click());
  await settlePage();
  assert.match(pageText(renderer), /Page 1/);
  assert.deepEqual(body(listRequests()[2] as RecordedRequest), { limit: 20 });
});

test("the waiting count is visible in the header without paging the queue", async (context) => {
  directoryFetch(context, {
    count: () => jsonResponse({ count: 3, truncated: false }),
  });
  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /3 awaiting review/);
  assert.match(text, /Review queue \(3\)/);
});

test("a truncated count reads as at-least, never as an exact figure", async (context) => {
  directoryFetch(context, {
    count: () => jsonResponse({ count: 500, truncated: true }),
  });
  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /500\+ awaiting review/);
  assert.match(text, /Review queue \(500\+\)/);
});

test("the review queue lists waiting identities oldest-first from the queue read", async (context) => {
  const { queueRequests, listRequests } = directoryFetch(context);
  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();
  assert.equal(listRequests().length, 1);

  await openQueue(renderer);

  // The queue is its own protected read; the filter travels in the body.
  const [queueRequest] = queueRequests();
  assert.equal(String(queueRequest?.input), "/api/product-users/access/queue");
  assert.equal(queueRequest?.init?.method, "POST");
  assert.deepEqual(body(queueRequest as RecordedRequest), { limit: 20 });

  const text = pageText(renderer);
  assert.match(text, /Awaiting a decision/);
  assert.match(text, /oldest request first/);
  // Rows render in the backend's oldest-first order.
  const labels = [
    ...renderer.container.querySelectorAll(".product-users__label"),
  ].map((label) => label.textContent?.trim() ?? "");
  assert.equal(labels.length, 2);
  assert.equal(labels[0], "waiting@example.test");
  assert.match(labels[1] ?? "", /did:example:opaque/);
  // The queue has no search; the ledger search belongs to the full listing.
  assert.equal(
    renderer.container.querySelector("#product-user-search"),
    null,
  );
});

test("an empty queue says nobody is waiting, distinctly from an empty directory", async (context) => {
  directoryFetch(context, {
    queue: () =>
      jsonResponse({ items: [], nextCursor: null, queueTruncated: false }),
    count: () => jsonResponse({ count: 0, truncated: false }),
  });
  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();
  await openQueue(renderer);

  const text = pageText(renderer);
  assert.match(text, /No one is waiting for a decision/);
  assert.doesNotMatch(text, /No users have signed up yet/);
});

test("a truncated queue explains it is complete from the front", async (context) => {
  directoryFetch(context, {
    queue: () =>
      jsonResponse({
        items: [waitingUser],
        nextCursor: null,
        queueTruncated: true,
      }),
  });
  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();
  await openQueue(renderer);

  const text = pageText(renderer);
  assert.match(text, /longer than this bounded view can show/);
  assert.match(text, /work it oldest-first/i);
});

test("approving from the queue confirms the consequence, then updates the row in place", async (context) => {
  const { decisionRequests, countRequests } = directoryFetch(context, {
    decide: () =>
      jsonResponse({
        action: "approve",
        changed: true,
        access: {
          state: "approved",
          decidedBy: "operator",
          decidedAt: "2026-08-20T10:00:00.000Z",
        },
        effectiveAccess: { admitted: true, reason: "approved" },
      }),
  });
  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();
  await openQueue(renderer);

  await act(async () => findButton(renderer, "Approve").click());
  await settlePage();

  // Nothing has happened yet: the administrator is being told what will.
  assert.equal(decisionRequests().length, 0);
  const confirmText = pageText(renderer);
  assert.match(confirmText, /Approve access for this person\?/);
  assert.match(confirmText, /admits this person to the PackScout closed beta immediately/);
  assert.match(confirmText, /let straight into the product/);
  assert.match(confirmText, /nothing about their account is ever deleted/);
  // A confirmation is a decision, so declining it must also be possible.
  findButton(renderer, "Cancel");

  const countsBefore = countRequests().length;
  await act(async () => findButton(renderer, "Approve access").click());
  await settlePage();

  const [decision] = decisionRequests();
  assert.equal(String(decision?.input), "/api/product-users/access/approve");
  assert.equal(decision?.init?.method, "POST");
  // The body names only the person; the action is the endpoint and the
  // operator is the session.
  assert.deepEqual(body(decision as RecordedRequest), {
    subject: waitingUser.subject,
  });

  // The row they acted on updates in place — approved now, with the revoke
  // control — and the rest of the queue stays exactly where it was.
  const text = pageText(renderer);
  assert.match(text, /Access approved\. They are in the beta now\./);
  const rows = [...renderer.container.querySelectorAll(".admin-ledger__rows article")];
  assert.equal(rows.length, 2);
  assert.match(rows[0]?.textContent ?? "", /Approved/);
  assert.match(rows[0]?.textContent ?? "", /Approved by an operator/);
  assert.ok(
    [...(rows[0]?.querySelectorAll("button") ?? [])].some(
      (button) => button.textContent?.trim() === "Revoke",
    ),
  );
  // The header count is re-read because the queue just changed size.
  assert.ok(countRequests().length > countsBefore);
});

test("a repeated decision reports the authoritative state rather than a change", async (context) => {
  directoryFetch(context, {
    decide: () =>
      jsonResponse({
        action: "approve",
        changed: false,
        access: {
          state: "approved",
          decidedBy: "allowlist",
          decidedAt: "2026-08-01T09:00:05.000Z",
        },
        effectiveAccess: { admitted: true, reason: "approved" },
      }),
  });
  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();
  await openQueue(renderer);

  await act(async () => findButton(renderer, "Approve").click());
  await settlePage();
  await act(async () => findButton(renderer, "Approve access").click());
  await settlePage();

  assert.match(pageText(renderer), /That person's access was already approved\./);
});

test("declining and revoking each state their own consequence before acting", async (context) => {
  directoryFetch(context, {
    decide: (request) =>
      pathOf(request).endsWith("/decline")
        ? jsonResponse({
            action: "decline",
            changed: true,
            access: {
              state: "declined",
              decidedBy: "operator",
              decidedAt: "2026-08-20T10:00:00.000Z",
            },
            effectiveAccess: { admitted: false, reason: "declined" },
          })
        : jsonResponse({
            action: "revoke",
            changed: true,
            access: {
              state: "awaiting_review",
              decidedBy: "operator",
              decidedAt: "2026-08-20T10:05:00.000Z",
            },
            effectiveAccess: { admitted: false, reason: "awaiting_review" },
          }),
  });
  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();
  await openQueue(renderer);

  // Decline, from the waiting row: the consequence names the notice, the kept
  // data, and that the allowlist cannot overturn it.
  await act(async () => findButton(renderer, "Decline").click());
  await settlePage();
  let confirmText = pageText(renderer);
  assert.match(confirmText, /Decline access for this person\?/);
  assert.match(confirmText, /declined notice instead of the product/);
  assert.match(confirmText, /everything they saved are kept/);
  assert.match(confirmText, /allowlist later will not overturn this decision/);
  await act(async () => findButton(renderer, "Decline access").click());
  await settlePage();
  assert.match(
    pageText(renderer),
    /Access declined\. Their sign-up record and saved items are kept\./,
  );

  // The declined row now offers Approve and Return to review — reversible in
  // both directions, with no deletion anywhere.
  const declinedRow = renderer.container.querySelector(
    ".admin-ledger__rows article",
  );
  assert.match(declinedRow?.textContent ?? "", /Declined by an operator/);
  await act(async () => findButton(renderer, "Return to review").click());
  await settlePage();
  confirmText = pageText(renderer);
  assert.match(confirmText, /Return this person to review\?/);
  assert.match(confirmText, /clears the decline/);
  assert.match(confirmText, /next sign-in will admit them automatically/);
  await act(async () => findButton(renderer, "Return to review", 1).click());
  await settlePage();
  assert.match(pageText(renderer), /back in the review queue/);
});

test("revoking an admitted account spells out the lockout and the allowlist caveat", async (context) => {
  directoryFetch(context, {
    decide: () =>
      jsonResponse({
        action: "revoke",
        changed: true,
        access: {
          state: "awaiting_review",
          decidedBy: "operator",
          decidedAt: "2026-08-20T10:00:00.000Z",
        },
        effectiveAccess: { admitted: false, reason: "awaiting_review" },
      }),
  });
  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  // The admitted account in the full ledger offers Revoke.
  await act(async () => findButton(renderer, "Revoke").click());
  await settlePage();
  const confirmText = pageText(renderer);
  assert.match(confirmText, /Revoke this person's access\?/);
  assert.match(confirmText, /on their very next request/);
  assert.match(confirmText, /Nothing they saved is deleted/);
  assert.match(confirmText, /decline them instead if they must stay out/);

  await act(async () => findButton(renderer, "Revoke access").click());
  await settlePage();
  assert.match(
    pageText(renderer),
    /Access revoked\. They are back in the review queue/,
  );
});

test("cancelling a decision leaves the account exactly as it was", async (context) => {
  const { decisionRequests } = directoryFetch(context);
  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();
  await openQueue(renderer);

  await act(async () => findButton(renderer, "Approve").click());
  await settlePage();
  await act(async () => findButton(renderer, "Cancel").click());
  await settlePage();

  assert.equal(decisionRequests().length, 0);
  assert.doesNotMatch(pageText(renderer), /Approve access for this person\?/);
  assert.match(pageText(renderer), /Awaiting review/);
  findButton(renderer, "Approve");
});

test("suspending from the ledger states the consequence first, then shows the new standing", async (context) => {
  const { requests } = directoryFetch(context, {
    list: () =>
      jsonResponse({
        items: [emailUser],
        nextCursor: null,
        searchTruncated: false,
      }),
    standing: () =>
      jsonResponse({
        user: { ...emailUser, standing: "suspended" },
        changed: true,
      }),
  });

  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  await act(async () => findButton(renderer, "Suspend").click());
  await settlePage();

  // Nothing has happened yet: the administrator is being told what will.
  assert.equal(
    requests.filter((request) => pathOf(request).endsWith("/standing")).length,
    0,
  );
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

  const standingRequests = requests.filter((request) =>
    pathOf(request).endsWith("/standing"),
  );
  assert.equal(standingRequests.length, 1);
  assert.equal(String(standingRequests[0]?.input), "/api/product-users/standing");
  assert.equal(standingRequests[0]?.init?.method, "POST");
  assert.deepEqual(body(standingRequests[0] as RecordedRequest), {
    subject: emailUser.subject,
    standing: "suspended",
  });

  // The ledger reflects the standing the backend reported, and the control
  // now offers the reverse — without reloading the listing under the operator.
  const text = pageText(renderer);
  assert.match(text, /Suspended/);
  assert.match(text, /Account suspended\. Everything they saved is kept\./);
  findButton(renderer, "Reinstate");
  assert.equal(
    requests.filter((request) => pathOf(request).endsWith("/standing")).length,
    1,
  );
});

test("an operator who cannot manage accounts sees state and no controls anywhere", async (context) => {
  directoryFetch(context);
  const renderer = await renderPage(route(viewer));
  cleanupPage(context, renderer);
  await settlePage();

  const controlPattern =
    /suspend|reinstate|approve|decline|revoke|return to review|delete|remove|purge/i;
  const labels = [...renderer.container.querySelectorAll("button")].map(
    (button) => button.textContent?.trim() ?? "",
  );
  assert.deepEqual(labels.filter((label) => controlPattern.test(label)), []);
  // Standing and access are still readable; only the controls are absent.
  let text = pageText(renderer);
  assert.match(text, /Active/);
  assert.match(text, /Suspended/);
  assert.match(text, /Approved/);
  assert.match(text, /Awaiting review/);

  // The queue view is equally read-only for them.
  await openQueue(renderer);
  const queueLabels = [...renderer.container.querySelectorAll("button")].map(
    (button) => button.textContent?.trim() ?? "",
  );
  assert.deepEqual(
    queueLabels.filter(
      (label) => controlPattern.test(label) && !label.startsWith("Review queue"),
    ),
    [],
  );
  text = pageText(renderer);
  assert.match(text, /Awaiting review/);
});
