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
import { ForgotPasswordPage } from "./ForgotPasswordPage.tsx";
import { LoginPage } from "./LoginPage.tsx";

function page() {
  return (
    <MemoryRouter initialEntries={["/forgot-password"]}>
      <ForgotPasswordPage />
    </MemoryRouter>
  );
}

test("the sign-in screen links into a labelled, keyboard-reachable request form", () => {
  const login = renderToStaticMarkup(
    <MemoryRouter initialEntries={["/login"]}>
      <LoginPage />
    </MemoryRouter>,
  );
  assert.match(login, /href="\/forgot-password"/);
  assert.match(login, /Forgot your password\?/);

  const request = renderToStaticMarkup(page());
  assert.match(request, /Reset your password/);
  assert.match(request, /label for="reset-request-email">Email/);
  assert.match(request, /type="email"/);
  assert.match(request, /autoComplete="username"/);
  assert.match(request, /aria-label="Request a password reset"/);
  assert.match(request, /href="\/login"/);
  assert.match(request, /aria-live="polite"/);
});

test("every address receives the identical check-your-mail confirmation", async (context) => {
  const requests = stubFetch(context, () =>
    jsonResponse({ status: "accepted" }, 202),
  );
  const renderer = await renderPage(page());
  cleanupPage(context, renderer);

  await act(async () => changeControl(renderer, "reset-request-email", "operator@packscout.test"));
  await act(async () => findButton(renderer, "Send reset link").click());
  await settlePage();
  const knownText = pageText(renderer);
  assert.match(knownText, /Check your mail\./);
  assert.match(
    knownText,
    /If that address belongs to an operator account, a reset link is on its way/,
  );
  assert.ok(renderer.container.querySelector('[role="status"]'));

  // Ask again with an address nobody registered: the page cannot and does
  // not distinguish it.
  await act(async () => findButton(renderer, "Request another link").click());
  await settlePage();
  await act(async () => changeControl(renderer, "reset-request-email", "nobody@packscout.test"));
  await act(async () => findButton(renderer, "Send reset link").click());
  await settlePage();
  assert.equal(pageText(renderer), knownText);

  assert.equal(requests.length, 2);
  const [first, second] = requests.map((request) =>
    JSON.parse(String(request.init?.body)),
  );
  assert.deepEqual(first, { email: "operator@packscout.test" });
  assert.deepEqual(second, { email: "nobody@packscout.test" });
  assert.ok(String(requests[0]?.input).endsWith("/auth/password-reset/request"));
});

test("validation and service failures stay on the form with a clear message", async (context) => {
  let status = 422;
  stubFetch(context, () =>
    status === 422
      ? jsonResponse(
          {
            error: "Check the reset form and try again.",
            code: "VALIDATION_FAILED",
            details: { email: ["Enter a valid email address."] },
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

  await act(async () => changeControl(renderer, "reset-request-email", "typo@packscout"));
  await act(async () => findButton(renderer, "Send reset link").click());
  await settlePage();
  assert.match(pageText(renderer), /Enter a valid email address\./);
  assert.ok(renderer.container.querySelector('[role="alert"]'));

  status = 503;
  await act(async () => changeControl(renderer, "reset-request-email", "operator@packscout.test"));
  await act(async () => findButton(renderer, "Send reset link").click());
  await settlePage();
  assert.match(
    pageText(renderer),
    /PackScout Admin is temporarily unavailable\. Your account has not been changed\./,
  );
  // Still on the form, ready to try again.
  assert.ok(renderer.container.querySelector("#reset-request-email"));
});
