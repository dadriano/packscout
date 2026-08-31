import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AuthSessionResponse,
  OperatorPermission,
  ProductUserDetail,
  ProductUserSavedRepack,
} from "@packscout/contracts";
import { act } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { productUserHandle } from "../components/product-users/subject-handle.ts";
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
  type RecordedRequest,
} from "../testing/react-page-test.tsx";
import { ProductUserDetailPage } from "./ProductUserDetailPage.tsx";

const subject = "https://auth.example.test/|did:example:email-user";

const user = {
  subject,
  authMethod: "https://auth.example.test",
  email: null,
  profile: { name: "Ada Lovelace", email: "ada@example.test" },
  walletAddress: "0xWalletAddress0001",
  firstSeenAt: "2026-08-01T09:00:00.000Z",
  lastSeenAt: "2026-08-19T12:00:00.000Z",
  standing: "active",
  access: {
    state: "awaiting_review",
    decidedBy: "default",
    decidedAt: "2026-08-01T09:00:00.000Z",
  },
} as const;

const resolvedRepack: ProductUserSavedRepack = {
  resolution: "resolved",
  publicRepackId: "40000000-0000-5000-8000-000000000001",
  savedAt: "2026-08-19T12:00:03.000Z",
  name: "Mythic Pokemon Gacha",
  vendorDisplayName: "Collector Crypt",
  availability: "available",
  estimatedEv: {
    evDollarsMinorUnits: 12_500,
    grossReturnBasisPoints: 10_500,
    confidenceBand: "high",
  },
};
const unavailableRepack: ProductUserSavedRepack = {
  resolution: "resolved",
  publicRepackId: "40000000-0000-5000-8000-000000000002",
  savedAt: "2026-08-19T12:00:02.800Z",
  name: "Temporarily Unavailable Pack",
  vendorDisplayName: "Phygitals",
  availability: "unavailable",
  estimatedEv: null,
};
const unknownRepack: ProductUserSavedRepack = {
  resolution: "resolved",
  publicRepackId: "40000000-0000-5000-8000-000000000003",
  savedAt: "2026-08-19T12:00:02.600Z",
  name: "Unconfirmed Availability Pack",
  vendorDisplayName: "ClutchPacks",
  availability: "unknown",
  estimatedEv: null,
};
const soldOutRepack: ProductUserSavedRepack = {
  resolution: "resolved",
  publicRepackId: "40000000-0000-5000-8000-000000000006",
  savedAt: "2026-08-19T12:00:02.000Z",
  name: "Sold Out Basketball Grails",
  vendorDisplayName: "Courtyard",
  availability: "sold_out",
  estimatedEv: null,
};
const unresolvedRepack: ProductUserSavedRepack = {
  resolution: "unresolved",
  publicRepackId: "40000000-0000-5000-8000-000000000999",
  savedAt: "2026-08-19T12:00:01.000Z",
};

const detail = {
  user,
  catalogAvailable: true,
  savedRepacks: [
    resolvedRepack,
    unavailableRepack,
    unknownRepack,
    soldOutRepack,
    unresolvedRepack,
  ],
  savedCollectibles: [
    {
      resolution: "resolved",
      publicCollectibleId: "30000000-0000-5000-8000-000000000001",
      savedAt: "2026-08-19T12:00:04.000Z",
      name: "1999 Pokemon Base Set Charizard Holo PSA 10",
      collectibleType: "sealed_product",
    },
  ],
} as ProductUserDetail;

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

/**
 * Detail views are opened from the directory, which issues an opaque handle
 * for the row and keeps the subject key out of the URL entirely.
 */
function route(
  permissions: readonly OperatorPermission[] = administrator,
  entry = `/users/${productUserHandle(subject)}`,
) {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <SessionProvider initialSession={session(permissions)}>
          <MemoryRouter initialEntries={[entry]}>
            <Routes>
              <Route
                path="/users/:handle"
                element={<ProductUserDetailPage />}
              />
            </Routes>
          </MemoryRouter>
        </SessionProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}

function body({ init }: RecordedRequest): Record<string, unknown> {
  return JSON.parse(String(init?.body ?? "{}"));
}

test("a user's identity and both saved collections render, newest save first", async (context) => {
  const load = deferred<Response>();
  const requests = stubFetch(context, () => load.promise);

  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  assert.match(pageText(renderer), /Loading this user/);

  load.resolve(jsonResponse(detail));
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /Ada Lovelace/);
  assert.match(text, /ada@example\.test/);
  assert.match(text, /0xWalletAddress0001/);
  assert.match(text, /Sign-in source/);
  assert.match(text, /Active/);
  assert.match(text, /did:example:email-user/);

  // Both collections are present and separately headed.
  assert.match(text, /Saved repacks/);
  assert.match(text, /Saved collectibles/);
  assert.match(text, /Mythic Pokemon Gacha/);
  assert.match(text, /Collector Crypt/);
  assert.match(text, /Available now/);
  assert.match(text, /Unavailable/);
  assert.match(text, /Availability unknown/);
  assert.match(text, /Sold out/);
  assert.match(text, /\+\$125\.00 EV · 105% of price · high confidence/);
  assert.match(text, /No current estimate/);
  assert.match(text, /Sealed product/);

  const repackNames = [
    ...renderer.container.querySelectorAll(
      '[aria-labelledby="saved-repacks-title"] .saved-items__heading strong',
    ),
  ].map((node) => node.textContent);
  assert.deepEqual(repackNames, [
    "Mythic Pokemon Gacha",
    "Temporarily Unavailable Pack",
    "Unconfirmed Availability Pack",
    "Sold Out Basketball Grails",
    "No longer in the current catalog",
  ]);

  // The subject key travels in the request body, never in the request URL.
  assert.equal(String(requests[0]?.input), "/api/product-users/detail");
  assert.equal(requests[0]?.init?.method, "POST");
  assert.deepEqual(body(requests[0] as RecordedRequest), { subject });
});

test("missing profile details remain explicit while recorded identifiers stay available", async (context) => {
  stubFetch(context, () =>
    jsonResponse({
      ...detail,
      user: { ...user, profile: null, email: "recorded@example.test" },
    }),
  );
  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  const identitySection = renderer.container.querySelector(
    '[aria-labelledby="product-user-identity"]',
  );
  const text = identitySection?.textContent ?? "";
  assert.match(text, /NameNot available/);
  assert.match(text, /Emailrecorded@example\.test/);
  assert.match(text, /0xWalletAddress0001/);
  assert.match(text, /did:example:email-user/);
  assert.doesNotMatch(text, /Ada Lovelace|ada@example\.test/);
});

test("the detail route addresses the user by an opaque handle, never their subject key", async (context) => {
  const entry = `/users/${productUserHandle(subject)}`;
  const requests = stubFetch(context, () => jsonResponse(detail));
  const renderer = await renderPage(route(administrator, entry));
  cleanupPage(context, renderer);
  await settlePage();

  // The URL that reaches history, logs, and the sign-in returnTo names nobody.
  assert.match(entry, /^\/users\/[0-9a-f]{32}$/);
  assert.ok(!entry.includes(subject));
  assert.ok(!entry.includes(encodeURIComponent(subject)));
  assert.ok(!entry.includes(encodeURIComponent(user.profile.name)));
  assert.ok(!entry.includes(encodeURIComponent(user.profile.email)));
  assert.doesNotMatch(decodeURIComponent(entry), /did:|auth\.example\.test/);

  // The subject still reaches the server, in the POST body and only there.
  assert.equal(String(requests[0]?.input), "/api/product-users/detail");
  assert.deepEqual(body(requests[0] as RecordedRequest), { subject });
  assert.match(pageText(renderer), /Mythic Pokemon Gacha/);
});

test("a link this tab never issued identifies nobody and asks nothing of the server", async (context) => {
  const requests = stubFetch(context, () => jsonResponse(detail));
  const renderer = await renderPage(
    route(administrator, "/users/00000000000000000000000000000000"),
  );
  cleanupPage(context, renderer);
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /Open this user from the directory/);
  assert.match(text, /only work in the tab that opened them/);
  assert.match(text, /Nothing has been changed/);
  // No guess is made about who was meant, so nothing is read and nothing shown.
  assert.equal(requests.length, 0);
  assert.doesNotMatch(text, /ada@example\.test|Mythic Pokemon Gacha/);
  assert.equal(
    [...renderer.container.querySelectorAll("a")].some(
      (link) => link.textContent?.trim() === "Back to users",
    ),
    true,
  );
});

test("an item the catalog no longer carries stays listed and identified", async (context) => {
  stubFetch(context, () =>
    jsonResponse({
      ...detail,
      savedRepacks: [unresolvedRepack],
      savedCollectibles: [],
    }),
  );
  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /No longer in the current catalog/);
  // Its stable identifier stays on the row so it remains investigable.
  assert.match(text, /40000000-0000-5000-8000-000000000999/);
  // Such a row can vanish through the user's own saving, which is stated.
  assert.match(
    text,
    /saving another item drops their oldest item of that kind/,
  );
  assert.doesNotMatch(text, /Mythic Pokemon Gacha/);
  // The collection with nothing in it reads as empty, not as an error.
  assert.match(text, /This user has not saved any collectibles/);
});

test("an unreadable catalog is not reported as items leaving the catalog", async (context) => {
  stubFetch(context, () =>
    jsonResponse({
      ...detail,
      catalogAvailable: false,
      savedRepacks: [unresolvedRepack],
      savedCollectibles: [],
    }),
  );
  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /No active catalog could be read/);
  assert.match(text, /Not resolved: the active catalog could not be read/);
  assert.doesNotMatch(text, /No longer in the current catalog/);
});

test("a user who has saved nothing shows a distinct empty state per collection", async (context) => {
  stubFetch(context, () =>
    jsonResponse({ ...detail, savedRepacks: [], savedCollectibles: [] }),
  );
  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /This user has not saved any repacks/);
  assert.match(text, /This user has not saved any collectibles/);
  assert.equal(
    renderer.container.querySelectorAll(".saved-items__rows li").length,
    0,
  );
});

test("a collection at the per-kind cap renders bounded and can be expanded", async (context) => {
  const capped = Array.from(
    { length: 250 },
    (_, index): ProductUserSavedRepack => ({
      resolution: "unresolved",
      publicRepackId: `40000000-0000-5000-8000-${String(index).padStart(12, "0")}`,
      savedAt: "2026-08-19T12:00:00.000Z",
    }),
  );
  stubFetch(context, () =>
    jsonResponse({ ...detail, savedRepacks: capped, savedCollectibles: [] }),
  );
  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  const rows = () =>
    renderer.container.querySelectorAll(
      '[aria-labelledby="saved-repacks-title"] .saved-items__rows li',
    ).length;
  assert.equal(rows(), 25);
  assert.match(pageText(renderer), /Showing 25 of 250/);

  await act(async () => findButton(renderer, "Show all 250").click());
  await settlePage();
  assert.equal(rows(), 250);
  assert.match(pageText(renderer), /Showing 250 of 250/);
});

test("no control on this view can change what the user has saved", async (context) => {
  const requests = stubFetch(context, () => jsonResponse(detail));
  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  const labels = [...renderer.container.querySelectorAll("button")].map(
    (button) => button.textContent?.trim() ?? "",
  );
  assert.deepEqual(
    labels.filter((label) => /remove|delete|unsave|add|edit/i.test(label)),
    [],
  );
  assert.equal(renderer.container.querySelectorAll("form").length, 0);
  // The only request the page makes is its read.
  assert.equal(requests.length, 1);
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
  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /This workspace is limited to administrators/);
  assert.match(text, /permission to view product users/);
  assert.doesNotMatch(text, /Saved repacks/);
  assert.doesNotMatch(text, /ada@example\.test/);
});

test("an unknown user and an unavailable service degrade without inventing data", async (context) => {
  stubFetch(context, (_request, index) =>
    index === 0
      ? jsonResponse(
          {
            error: "That product user is not in the directory.",
            code: "PRODUCT_USER_NOT_FOUND",
          },
          404,
        )
      : jsonResponse(
          {
            error: "The product-user directory is temporarily unavailable.",
            code: "PRODUCT_USER_DIRECTORY_UNAVAILABLE",
          },
          503,
        ),
  );
  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  const missing = pageText(renderer);
  assert.match(missing, /This user is not in the directory/);
  assert.match(missing, /Nothing has been changed/);
  assert.ok(renderer.container.querySelector('[role="alert"]'));
  assert.equal(
    renderer.container.querySelectorAll(".saved-items__rows").length,
    0,
  );
  // An unrecoverable state offers the way back rather than a pointless retry.
  assert.equal(
    [...renderer.container.querySelectorAll("a")].some(
      (link) => link.textContent?.trim() === "Back to users",
    ),
    true,
  );
});

test("a temporary failure offers a retry that reloads the user", async (context) => {
  stubFetch(context, (_request, index) =>
    index === 0
      ? jsonResponse(
          {
            error: "The product-user directory is temporarily unavailable.",
            code: "PRODUCT_USER_DIRECTORY_UNAVAILABLE",
          },
          503,
        )
      : jsonResponse(detail),
  );
  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();
  assert.match(pageText(renderer), /This user could not be loaded/);

  await act(async () => findButton(renderer, "Try again").click());
  await settlePage();
  assert.match(pageText(renderer), /Mythic Pokemon Gacha/);
});

const suspendedDetail = {
  ...detail,
  user: { ...user, standing: "suspended" },
} as ProductUserDetail;

function standingFetch(
  context: Parameters<typeof stubFetch>[0],
  loaded: ProductUserDetail,
  change: unknown,
) {
  return stubFetch(context, (request) =>
    String(request.input).endsWith("/product-users/standing")
      ? jsonResponse(change)
      : jsonResponse(loaded),
  );
}

test("reinstating from the detail view confirms first and never touches saved items", async (context) => {
  const requests = standingFetch(context, suspendedDetail, {
    user: { ...user, standing: "active" },
    changed: true,
  });
  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  const savedBefore = pageText(renderer).includes("Mythic Pokemon Gacha");
  assert.ok(savedBefore);

  await act(async () => findButton(renderer, "Reinstate").click());
  await settlePage();

  // The consequence is stated before anything happens.
  assert.equal(requests.length, 1);
  const confirmText = pageText(renderer);
  assert.match(confirmText, /Reinstate this account\?/);
  assert.match(confirmText, /restores this person's signed-in capabilities/);
  assert.match(confirmText, /still in place/);

  await act(async () => findButton(renderer, "Reinstate account").click());
  await settlePage();

  assert.equal(requests.length, 2);
  assert.equal(String(requests[1]?.input), "/api/product-users/standing");
  assert.deepEqual(body(requests[1] as RecordedRequest), {
    subject,
    standing: "active",
  });

  const text = pageText(renderer);
  assert.match(text, /Active/);
  assert.match(text, /Account reinstated/);
  assert.match(text, /Ada Lovelace/);
  assert.match(text, /ada@example\.test/);
  // Every saved item is exactly where it was; only the standing moved.
  assert.match(text, /Mythic Pokemon Gacha/);
  assert.match(text, /Sold Out Basketball Grails/);
  assert.match(text, /Charizard Holo PSA 10/);
  findButton(renderer, "Suspend");
});

test("a repeat action reports the authoritative standing without claiming a change", async (context) => {
  // Another administrator suspended this account a moment ago, so the backend
  // reports the standing already reached rather than refusing.
  const requests = standingFetch(context, detail, {
    user: { ...user, standing: "suspended" },
    changed: false,
  });
  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  await act(async () => findButton(renderer, "Suspend").click());
  await settlePage();
  await act(async () => findButton(renderer, "Suspend account").click());
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /That account was already suspended\./);
  assert.doesNotMatch(
    text,
    /Account suspended\. Everything they saved is kept\./,
  );
  // The view converges on the authoritative standing rather than an error.
  assert.match(text, /Suspended/);
  assert.doesNotMatch(text, /failed/i);
  findButton(renderer, "Reinstate");
  assert.equal(requests.length, 2);
});

test("a refused account change is reported without changing the standing shown", async (context) => {
  const requests = stubFetch(context, (request) =>
    String(request.input).endsWith("/product-users/standing")
      ? jsonResponse(
          {
            error: "The product-user directory is temporarily unavailable.",
            code: "PRODUCT_USER_DIRECTORY_UNAVAILABLE",
          },
          503,
        )
      : jsonResponse(detail),
  );
  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  await act(async () => findButton(renderer, "Suspend").click());
  await settlePage();
  await act(async () => findButton(renderer, "Suspend account").click());
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /The action failed/);
  assert.match(text, /temporarily unavailable/);
  assert.doesNotMatch(text, /Bearer|token|convex/i);
  // The dialog stays open with the account unchanged, and the saved items are
  // untouched by a refusal just as they are by a success.
  assert.match(text, /Mythic Pokemon Gacha/);
  assert.equal(requests.length, 2);
});

test("an operator who cannot manage accounts sees the standing and no control", async (context) => {
  const requests = stubFetch(context, () => jsonResponse(suspendedDetail));
  const renderer = await renderPage(route(viewer));
  cleanupPage(context, renderer);
  await settlePage();

  const labels = [...renderer.container.querySelectorAll("button")].map(
    (button) => button.textContent?.trim() ?? "",
  );
  assert.deepEqual(
    labels.filter((label) =>
      /suspend|reinstate|approve|decline|revoke|return to review|delete|remove|purge/i.test(
        label,
      ),
    ),
    [],
  );
  // Standing and access are still readable; only the controls are absent.
  assert.match(pageText(renderer), /Suspended/);
  assert.match(pageText(renderer), /Awaiting review/);
  assert.equal(requests.length, 1);
});

test("the detail view shows beta access with provenance and decides in place", async (context) => {
  const requests = stubFetch(context, (request) =>
    String(request.input).endsWith("/product-users/access/approve")
      ? jsonResponse({
          action: "approve",
          changed: true,
          access: {
            state: "approved",
            decidedBy: "operator",
            decidedAt: "2026-08-20T10:00:00.000Z",
          },
          effectiveAccess: { admitted: true, reason: "approved" },
        })
      : jsonResponse(detail),
  );
  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  // The waiting account reads as waiting — the pending tone, never the
  // danger tone — with its provenance and date alongside the standing.
  let text = pageText(renderer);
  assert.match(text, /Awaiting review/);
  assert.match(text, /Beta access/);
  assert.match(text, /Awaiting a first decision/);
  const badges = [
    ...renderer.container.querySelectorAll(".admin-pill"),
  ].map((badge) => ({
    label: badge.textContent?.trim(),
    pending: badge.classList.contains("admin-pill-warning"),
    danger: badge.classList.contains("admin-pill-danger"),
  }));
  assert.deepEqual(badges[0], {
    label: "Awaiting review",
    pending: true,
    danger: false,
  });

  await act(async () => findButton(renderer, "Approve").click());
  await settlePage();
  // The consequence is stated before anything happens.
  assert.equal(requests.length, 1, "the page has only read until confirmation");
  assert.match(pageText(renderer), /Approve access for this person\?/);

  await act(async () => findButton(renderer, "Approve access").click());
  await settlePage();

  const decision = requests.at(-1);
  assert.equal(String(decision?.input), "/api/product-users/access/approve");
  assert.deepEqual(body(decision as RecordedRequest), { subject });

  // The view reflects the decision the backend reported, in place, with the
  // reverse control now offered and every saved item untouched.
  text = pageText(renderer);
  assert.match(text, /Access approved\. They are in the beta now\./);
  assert.match(text, /Approved by an operator/);
  findButton(renderer, "Revoke");
  assert.match(text, /Mythic Pokemon Gacha/);
});
