import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AuthSessionResponse,
  BetaAllowlistRow,
  OperatorPermission,
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
import { BetaAllowlistPage } from "./BetaAllowlistPage.tsx";

const emailRow: BetaAllowlistRow = {
  entryId: "entry-0000000000000001",
  email: "ada@example.test",
  walletAddress: "0xWalletAddress0001",
  label: "First invite wave",
  createdAt: "2026-08-19T12:00:00.000Z",
  updatedAt: "2026-08-19T12:00:00.000Z",
  createdByOperatorId: "00000000-0000-4000-8000-000000000001",
  createdByDisplayName: "Primary Admin",
};
const walletRow: BetaAllowlistRow = {
  ...emailRow,
  entryId: "entry-0000000000000002",
  email: null,
  walletAddress: "0xWalletAddress0002",
  label: null,
  createdAt: "2026-08-18T08:00:00.000Z",
  updatedAt: "2026-08-18T08:00:00.000Z",
  createdByOperatorId: "00000000-0000-4000-8000-000000000099",
  createdByDisplayName: null,
};

const administrator: readonly OperatorPermission[] = [
  "beta_allowlist:view",
  "beta_allowlist:manage",
];
/** A viewer holds the read permission and not the entry controls. */
const viewer: readonly OperatorPermission[] = ["beta_allowlist:view"];

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
      role: permissions.includes("beta_allowlist:manage")
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
          <MemoryRouter initialEntries={["/allowlist"]}>
            <BetaAllowlistPage />
          </MemoryRouter>
        </SessionProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}

function body({ init }: RecordedRequest): Record<string, unknown> {
  return JSON.parse(String(init?.body ?? "{}"));
}

function listPage(items: readonly BetaAllowlistRow[]) {
  return jsonResponse({ items, nextCursor: null, searchTruncated: false });
}

async function search(
  renderer: Awaited<ReturnType<typeof renderPage>>,
  term: string,
): Promise<void> {
  await act(async () => changeControl(renderer, "beta-allowlist-search", term));
  await act(async () => {
    const form = renderer.container.querySelector<HTMLFormElement>(
      'form[aria-label="Search the beta allowlist"]',
    );
    if (!form) throw new Error("The allowlist search form was not found.");
    form.dispatchEvent(
      new renderer.dom.window.Event("submit", { bubbles: true, cancelable: true }),
    );
  });
  await settlePage();
}

async function submitEntryForm(
  renderer: Awaited<ReturnType<typeof renderPage>>,
): Promise<void> {
  await act(async () => {
    const form = renderer.container.querySelector<HTMLFormElement>(
      "#beta-allowlist-entry-form",
    );
    if (!form) throw new Error("The allowlist entry form was not found.");
    form.dispatchEvent(
      new renderer.dom.window.Event("submit", { bubbles: true, cancelable: true }),
    );
  });
  await settlePage();
  await settlePage();
}

test("the allowlist lists entries newest first with identifiers, labels, and creators", async (context) => {
  const load = deferred<Response>();
  const requests = stubFetch(context, () => load.promise);

  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  assert.match(pageText(renderer), /Loading the allowlist/);

  load.resolve(listPage([emailRow, walletRow]));
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /ada@example\.test/);
  assert.match(text, /0xWalletAddress0001/);
  assert.match(text, /0xWalletAddress0002/);
  assert.match(text, /First invite wave/);
  assert.match(text, /No label/);
  assert.match(text, /Added by/);
  // A resolvable creator reads as a person; an unresolvable one still reads
  // as a stable reference rather than vanishing.
  assert.match(text, /Primary Admin/);
  assert.match(text, /00000000-0000-4000-8000-000000000099/);
  assert.equal(
    renderer.container.querySelectorAll(".admin-row-list article").length,
    2,
  );

  // Identifiers travel in the request body; the URL carries nothing.
  assert.equal(String(requests[0]?.input), "/api/beta-allowlist/list");
  assert.equal(requests[0]?.init?.method, "POST");
  assert.deepEqual(body(requests[0] as RecordedRequest), { limit: 20 });
  // An allowlist entry has no detail view, so no link exists to carry one.
  assert.equal(renderer.container.querySelectorAll("a").length, 0);
});

test("an empty allowlist and an empty search read differently", async (context) => {
  const requests = stubFetch(context, (request) =>
    body(request).search === undefined
      ? listPage([emailRow])
      : listPage([]),
  );

  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  await search(renderer, "  nobody@example.test  ");
  const noMatch = pageText(renderer);
  assert.match(noMatch, /No allowlist entries match this search/);
  assert.doesNotMatch(noMatch, /No one has been added to the allowlist yet/);
  assert.deepEqual(body(requests[1] as RecordedRequest), {
    search: "nobody@example.test",
    limit: 20,
  });

  // Clearing the search returns to the unfiltered ledger.
  await act(async () => findButton(renderer, "Clear search").click());
  await settlePage();
  assert.match(pageText(renderer), /ada@example\.test/);
});

test("an allowlist with no entries yet says so plainly", async (context) => {
  stubFetch(context, () => listPage([]));
  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /No one has been added to the allowlist yet/);
  assert.match(text, /admitted automatically the first time they sign in/);
  assert.doesNotMatch(text, /No allowlist entries match this search/);
});

test("an operator without the view permission gets the access-restricted state", async (context) => {
  stubFetch(context, () =>
    jsonResponse(
      {
        error: "You do not have permission to perform this action.",
        code: "FORBIDDEN",
      },
      403,
    ),
  );
  const renderer = await renderPage(route(viewer));
  cleanupPage(context, renderer);
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /This workspace is limited to administrators/);
  assert.match(text, /permission to view the beta allowlist/);
  assert.doesNotMatch(text, /Invitation ledger/);
  assert.doesNotMatch(text, /Search email or wallet address/);
});

test("an unavailable integration degrades to a bounded, non-destructive error", async (context) => {
  stubFetch(context, () =>
    jsonResponse(
      {
        error: "The beta-allowlist integration is not configured.",
        code: "BETA_ALLOWLIST_UNCONFIGURED",
      },
      503,
    ),
  );
  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /The beta allowlist is not connected/);
  assert.match(text, /Nothing has been changed/);
  assert.doesNotMatch(text, /Bearer|token|convex/i);
  assert.equal(
    renderer.container.querySelectorAll(".admin-row-list article").length,
    0,
  );
  assert.ok(renderer.container.querySelector('[role="alert"]'));
});

test("adding an entry reports how many waiting accounts it admitted", async (context) => {
  const requests = stubFetch(context, (request) =>
    String(request.input).endsWith("/beta-allowlist/create")
      ? jsonResponse({ entry: emailRow, admittedCount: 2 })
      : listPage([emailRow]),
  );

  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  await act(async () => findButton(renderer, "Add entry").click());
  await settlePage();
  assert.match(pageText(renderer), /Add an allowlist entry/);
  assert.match(
    pageText(renderer),
    /adding the entry admits them immediately/,
  );

  await act(async () =>
    changeControl(renderer, "beta-allowlist-email", "  Ada@Example.test  "),
  );
  await act(async () =>
    changeControl(renderer, "beta-allowlist-label", "First invite wave"),
  );
  await submitEntryForm(renderer);

  // The create carried exactly the stated fields — no operator identity, no
  // empty placeholders — and the listing was reloaded to show the new entry.
  assert.equal(String(requests[1]?.input), "/api/beta-allowlist/create");
  assert.equal(requests[1]?.init?.method, "POST");
  assert.deepEqual(body(requests[1] as RecordedRequest), {
    email: "Ada@Example.test",
    label: "First invite wave",
  });
  assert.equal(String(requests[2]?.input), "/api/beta-allowlist/list");

  const text = pageText(renderer);
  // The operator sees the retroactive effect, not just "added".
  assert.match(text, /Allowlist entry added, and admitted 2 waiting accounts\./);
  assert.doesNotMatch(text, /Add an allowlist entry/);
});

test("an add that admits nobody says so instead of implying it did", async (context) => {
  stubFetch(context, (request) =>
    String(request.input).endsWith("/beta-allowlist/create")
      ? jsonResponse({ entry: walletRow, admittedCount: 0 })
      : listPage([walletRow]),
  );

  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  await act(async () => findButton(renderer, "Add entry").click());
  await settlePage();
  await act(async () =>
    changeControl(
      renderer,
      "beta-allowlist-wallet-address",
      "0xWalletAddress0002",
    ),
  );
  await submitEntryForm(renderer);

  assert.match(
    pageText(renderer),
    /Allowlist entry added\. No waiting accounts matched it, so nobody was admitted by this change\./,
  );
});

test("a duplicate identifier keeps the dialog open with a human message", async (context) => {
  const requests = stubFetch(context, (request) =>
    String(request.input).endsWith("/beta-allowlist/create")
      ? jsonResponse(
          {
            error: "Another allowlist entry already covers this email address.",
            code: "BETA_ALLOWLIST_DUPLICATE_EMAIL",
          },
          409,
        )
      : listPage([emailRow]),
  );

  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  await act(async () => findButton(renderer, "Add entry").click());
  await settlePage();
  await act(async () =>
    changeControl(renderer, "beta-allowlist-email", "ada@example.test"),
  );
  await submitEntryForm(renderer);

  const text = pageText(renderer);
  assert.match(text, /Another allowlist entry already covers this email address/);
  // The dialog stays open with the operator's typing preserved.
  assert.match(text, /Add an allowlist entry/);
  const emailInput = renderer.container.querySelector<HTMLInputElement>(
    "#beta-allowlist-email",
  );
  assert.equal(emailInput?.value, "ada@example.test");
  // The refusal changed nothing, so nothing was reloaded.
  assert.equal(requests.length, 2);
});

test("an entry needs an email address or a wallet address before anything is sent", async (context) => {
  const requests = stubFetch(context, () => listPage([emailRow]));

  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  await act(async () => findButton(renderer, "Add entry").click());
  await settlePage();
  await submitEntryForm(renderer);

  assert.match(
    pageText(renderer),
    /Enter an email address, a wallet address, or both\./,
  );
  // Nothing traveled: the only request remains the initial listing.
  assert.equal(requests.length, 1);
});

test("editing states the entry in full and updates the row in place", async (context) => {
  const requests = stubFetch(context, (request) =>
    String(request.input).endsWith("/beta-allowlist/update")
      ? jsonResponse({
          entry: {
            ...emailRow,
            walletAddress: null,
            label: "Second wave",
            updatedAt: "2026-08-20T09:00:00.000Z",
          },
          admittedCount: 1,
        })
      : listPage([emailRow, walletRow]),
  );

  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  await act(async () => findButton(renderer, "Edit").click());
  await settlePage();
  assert.match(pageText(renderer), /Edit this allowlist entry/);
  // The form opens with the entry as it stands.
  assert.equal(
    renderer.container.querySelector<HTMLInputElement>("#beta-allowlist-email")
      ?.value,
    "ada@example.test",
  );
  assert.equal(
    renderer.container.querySelector<HTMLInputElement>(
      "#beta-allowlist-wallet-address",
    )?.value,
    "0xWalletAddress0001",
  );

  await act(async () =>
    changeControl(renderer, "beta-allowlist-wallet-address", "  "),
  );
  await act(async () =>
    changeControl(renderer, "beta-allowlist-label", "Second wave"),
  );
  await submitEntryForm(renderer);

  // The edit named the entry and every field: the cleared wallet travels as
  // an explicit null, so "blank" can never silently mean "keep".
  assert.equal(String(requests[1]?.input), "/api/beta-allowlist/update");
  assert.deepEqual(body(requests[1] as RecordedRequest), {
    entryId: emailRow.entryId,
    email: "ada@example.test",
    walletAddress: null,
    label: "Second wave",
  });

  const text = pageText(renderer);
  assert.match(text, /Allowlist entry updated, and admitted 1 waiting account\./);
  assert.match(text, /Second wave/);
  assert.doesNotMatch(text, /0xWalletAddress0001/);
  // The row was updated in place; the listing did not reload under the
  // operator.
  assert.equal(requests.length, 2);
  assert.equal(
    renderer.container.querySelectorAll(".admin-row-list article").length,
    2,
  );
});

test("removal states both consequences before anything happens, then converges", async (context) => {
  const requests = stubFetch(context, (request) =>
    String(request.input).endsWith("/beta-allowlist/remove")
      ? jsonResponse({ removed: true })
      : listPage([emailRow, walletRow]),
  );

  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  await act(async () => findButton(renderer, "Remove").click());
  await settlePage();

  // Nothing has happened yet: the administrator is being told what will.
  assert.equal(requests.length, 1);
  const confirmText = pageText(renderer);
  assert.match(confirmText, /Remove this allowlist entry\?/);
  // Consequence one: automatic admission stops for these identifiers.
  assert.match(confirmText, /no longer be admitted automatically/);
  // Consequence two: nobody already approved is evicted, and revoking a
  // person lives elsewhere.
  assert.match(confirmText, /Anyone already approved keeps their access/);
  assert.match(confirmText, /separate action in the Users area/);
  // A confirmation is a decision, so declining it must also be possible.
  findButton(renderer, "Cancel");

  await act(async () => findButton(renderer, "Remove entry").click());
  await settlePage();

  assert.equal(String(requests[1]?.input), "/api/beta-allowlist/remove");
  assert.equal(requests[1]?.init?.method, "POST");
  assert.deepEqual(body(requests[1] as RecordedRequest), {
    entryId: emailRow.entryId,
  });

  const text = pageText(renderer);
  assert.match(text, /Allowlist entry removed\. Existing approvals are unchanged\./);
  // The removed row is gone without reloading the listing under the operator.
  assert.equal(requests.length, 2);
  assert.equal(
    renderer.container.querySelectorAll(".admin-row-list article").length,
    1,
  );
  assert.doesNotMatch(pageText(renderer), /ada@example\.test/);
});

test("an operator who cannot manage the allowlist sees entries and no controls", async (context) => {
  const requests = stubFetch(context, () => listPage([emailRow, walletRow]));
  const renderer = await renderPage(route(viewer));
  cleanupPage(context, renderer);
  await settlePage();

  const labels = [...renderer.container.querySelectorAll("button")].map(
    (button) => button.textContent?.trim() ?? "",
  );
  assert.deepEqual(
    labels.filter((label) => /add entry|edit|remove|delete/i.test(label)),
    [],
  );
  // The ledger is still readable; only the ability to change it is absent.
  const text = pageText(renderer);
  assert.match(text, /ada@example\.test/);
  assert.match(text, /0xWalletAddress0002/);
  assert.equal(requests.length, 1);
});
