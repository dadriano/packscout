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
import { ResetPasswordPage } from "./ResetPasswordPage.tsx";

const mailedToken = `${"a".repeat(22)}.${"b".repeat(43)}`;
const strongPassword = "a brand new strong password";

function page(entry = `/reset-password?token=${mailedToken}`) {
  return (
    <MemoryRouter initialEntries={[entry]}>
      <ResetPasswordPage />
    </MemoryRouter>
  );
}

test("a link with no token is the plain invalid-link state, without any request", async (context) => {
  const requests = stubFetch(context, () => jsonResponse({}, 500));
  const renderer = await renderPage(page("/reset-password"));
  cleanupPage(context, renderer);

  const text = pageText(renderer);
  assert.match(text, /This link is no longer valid\./);
  assert.match(text, /Request a new one to continue\./);
  assert.ok(renderer.container.querySelector('a[href="/forgot-password"]'));
  assert.ok(renderer.container.querySelector('a[href="/login"]'));
  assert.equal(requests.length, 0);
});

test("a presented token renders a labelled set-password form with the shared password guidance", () => {
  const html = renderToStaticMarkup(page());
  assert.match(html, /Choose a new password/);
  assert.match(html, /label for="reset-new-password">New password/);
  assert.match(html, /type="password"/);
  assert.match(html, /autoComplete="new-password"/);
  assert.match(html, /aria-describedby="reset-new-password-note"/);
  assert.match(html, /Use at least 12 characters\./);
  assert.match(html, /signs you out everywhere else/);
  assert.match(html, /aria-live="polite"/);
  // The token itself never appears in the rendered document.
  assert.doesNotMatch(html, new RegExp(mailedToken.slice(0, 22)));
});

test("the password rules are enforced with the schema's own message before any request", async (context) => {
  const requests = stubFetch(context, () => jsonResponse({}, 500));
  const renderer = await renderPage(page());
  cleanupPage(context, renderer);

  await act(async () => changeControl(renderer, "reset-new-password", "short"));
  await act(async () => findButton(renderer, "Set new password").click());
  await settlePage();

  assert.match(pageText(renderer), /Password must be at least 12 characters\./);
  assert.equal(requests.length, 0);
});

test("a valid submission posts the token with the password and reaches the signed-out-everywhere success state", async (context) => {
  const requests = stubFetch(context, () => new Response(null, { status: 204 }));
  const renderer = await renderPage(page());
  cleanupPage(context, renderer);

  await act(async () => changeControl(renderer, "reset-new-password", strongPassword));
  await act(async () => findButton(renderer, "Set new password").click());
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /Your password is updated\./);
  assert.match(text, /signed out everywhere/);
  assert.ok(renderer.container.querySelector('a[href="/login"]'));

  assert.equal(requests.length, 1);
  assert.ok(String(requests[0]?.input).endsWith("/auth/password-reset/complete"));
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    token: mailedToken,
    password: strongPassword,
  });
  // The new password is never echoed into the document.
  assert.doesNotMatch(text, /brand new strong/);
});

test("a dead link collapses into the same invalid-link state the missing token shows", async (context) => {
  stubFetch(context, () =>
    jsonResponse(
      {
        error: "This link is no longer valid. Request a new one.",
        code: "EMAIL_LINK_INVALID",
      },
      410,
    ),
  );
  const renderer = await renderPage(page());
  cleanupPage(context, renderer);

  await act(async () => changeControl(renderer, "reset-new-password", strongPassword));
  await act(async () => findButton(renderer, "Set new password").click());
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /This link is no longer valid\./);
  assert.ok(renderer.container.querySelector('a[href="/forgot-password"]'));
});

test("server-side validation and unavailability keep the form with a specific message", async (context) => {
  let status = 422;
  stubFetch(context, () =>
    status === 422
      ? jsonResponse(
          {
            error: "Check the new password and try again.",
            code: "VALIDATION_FAILED",
            details: { password: ["Password must be 128 characters or fewer."] },
          },
          422,
        )
      : jsonResponse(
          { error: "PackScout Admin is temporarily unavailable.", code: "SERVICE_UNAVAILABLE" },
          503,
        ),
  );
  const renderer = await renderPage(page());
  cleanupPage(context, renderer);

  await act(async () => changeControl(renderer, "reset-new-password", strongPassword));
  await act(async () => findButton(renderer, "Set new password").click());
  await settlePage();
  assert.match(pageText(renderer), /Password must be 128 characters or fewer\./);

  status = 503;
  await act(async () => findButton(renderer, "Set new password").click());
  await settlePage();
  assert.match(
    pageText(renderer),
    /PackScout Admin is temporarily unavailable\. Your password is unchanged\./,
  );
  assert.ok(renderer.container.querySelector("#reset-new-password"));
});
