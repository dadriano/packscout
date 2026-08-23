import assert from "node:assert/strict";
import { test } from "node:test";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
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
import { AcceptInvitationPage } from "./AcceptInvitationPage.tsx";

const mailedToken = `${"a".repeat(22)}.${"b".repeat(43)}`;
const chosenPassword = "a password only I know";

function page(entry = `/accept-invitation?token=${mailedToken}`) {
  return (
    <MemoryRouter initialEntries={[entry]}>
      <AcceptInvitationPage />
    </MemoryRouter>
  );
}

test("an invitation link with no token is the plain invalid-link state, without any request", async (context) => {
  const requests = stubFetch(context, () => jsonResponse({}, 500));
  const renderer = await renderPage(page("/accept-invitation"));
  cleanupPage(context, renderer);

  const text = pageText(renderer);
  assert.match(text, /This invitation link is no longer valid\./);
  assert.match(text, /Ask an administrator to send a new invitation\./);
  assert.ok(renderer.container.querySelector('a[href="/login"]'));
  assert.equal(requests.length, 0);
});

test("a presented invitation renders a labelled set-password form with the shared guidance", () => {
  const html = renderToStaticMarkup(page());
  assert.match(html, /Choose your password/);
  assert.match(html, /label for="invitation-new-password">Password/);
  assert.match(html, /type="password"/);
  assert.match(html, /autoComplete="new-password"/);
  assert.match(html, /aria-describedby="invitation-new-password-note"/);
  assert.match(html, /Use at least 12 characters\./);
  assert.match(html, /aria-live="polite"/);
  // The token itself never appears in the rendered document.
  assert.doesNotMatch(html, new RegExp(mailedToken.slice(0, 22)));
});

test("the admin's existing password rules are enforced with their own message before any request", async (context) => {
  const requests = stubFetch(context, () => jsonResponse({}, 500));
  const renderer = await renderPage(page());
  cleanupPage(context, renderer);

  await act(async () =>
    changeControl(renderer, "invitation-new-password", "short"),
  );
  await act(async () => findButton(renderer, "Activate my account").click());
  await settlePage();

  assert.match(pageText(renderer), /Password must be at least 12 characters\./);
  assert.equal(requests.length, 0);
});

test("a valid submission posts the token with the chosen password and reaches the activated state", async (context) => {
  const requests = stubFetch(context, () => new Response(null, { status: 204 }));
  const renderer = await renderPage(page());
  cleanupPage(context, renderer);

  await act(async () =>
    changeControl(renderer, "invitation-new-password", chosenPassword),
  );
  await act(async () => findButton(renderer, "Activate my account").click());
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /Your operator account is ready\./);
  assert.ok(renderer.container.querySelector('a[href="/login"]'));

  assert.equal(requests.length, 1);
  assert.ok(String(requests[0]?.input).endsWith("/auth/invitations/accept"));
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    token: mailedToken,
    password: chosenPassword,
  });
  // The chosen password is never echoed into the document.
  assert.doesNotMatch(text, /only I know/);
});

test("a cancelled, superseded, or expired link collapses into one invalid-link state", async (context) => {
  stubFetch(context, () =>
    jsonResponse(
      {
        error:
          "This invitation link is no longer valid. Ask an administrator to send a new one.",
        code: "EMAIL_LINK_INVALID",
      },
      410,
    ),
  );
  const renderer = await renderPage(page());
  cleanupPage(context, renderer);

  await act(async () =>
    changeControl(renderer, "invitation-new-password", chosenPassword),
  );
  await act(async () => findButton(renderer, "Activate my account").click());
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /This invitation link is no longer valid\./);
  // Exactly the wording the missing-token state shows, and nothing about
  // whether the account exists, who invited it, or what role it holds.
  assert.doesNotMatch(text, /cancelled|expired|superseded|role|administrator's/i);
});

test("an unavailable service says so plainly and leaves the form usable", async (context) => {
  stubFetch(context, () =>
    jsonResponse(
      { error: "PackScout Admin is temporarily unavailable.", code: "SERVICE_UNAVAILABLE" },
      503,
    ),
  );
  const renderer = await renderPage(page());
  cleanupPage(context, renderer);

  await act(async () =>
    changeControl(renderer, "invitation-new-password", chosenPassword),
  );
  await act(async () => findButton(renderer, "Activate my account").click());
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /temporarily unavailable/);
  assert.match(text, /Your account is unchanged\./);
  assert.ok(findButton(renderer, "Activate my account"));
});
