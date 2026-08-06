import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { LoginPage } from "./LoginPage.tsx";

test("login page renders a labelled, keyboard-operable focused sign-in form", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={["/login"]}>
      <LoginPage />
    </MemoryRouter>,
  );

  assert.match(html, /PackScout operations/);
  assert.match(html, /Sign in to continue/);
  assert.match(html, /label for="login-email">Email/);
  assert.match(html, /type="email"/);
  assert.match(html, /autoComplete="username"/);
  assert.match(html, /label for="login-password">Password/);
  assert.match(html, /type="password"/);
  assert.match(html, /autoComplete="current-password"/);
  assert.match(html, /aria-live="polite"/);
});

test("login page announces an expired session without exposing account state", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={["/login?reason=session_expired"]}>
      <LoginPage />
    </MemoryRouter>,
  );
  assert.match(html, /Your session ended. Sign in again to continue/);
  assert.match(html, /role="status"/);
});
