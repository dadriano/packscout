import assert from "node:assert/strict";
import { test } from "node:test";
import {
  permissionsForOperatorRole,
  type AuthSessionResponse,
} from "@packscout/contracts";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Routes } from "react-router-dom";
import { appRoutes } from "./App.tsx";
import { ThemeProvider } from "./hooks/useTheme.tsx";
import { ConfirmProvider } from "./providers/confirm.tsx";
import { SessionProvider } from "./providers/session.tsx";
import { ToastProvider } from "./providers/toast.tsx";

function session(role: "admin" | "data_operator"): AuthSessionResponse {
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
      role,
    },
    // The authoritative role grant, so navigation is tested against the
    // permissions the service actually issues.
    permissions: permissionsForOperatorRole(role),
    csrfToken: "csrf-test-token",
  };
}

function renderRoute(path: string, authSession: AuthSessionResponse): string {
  Object.assign(globalThis, { React });
  return renderToStaticMarkup(
    <React.Fragment>
    <ThemeProvider>
      <ToastProvider>
        <ConfirmProvider>
          <SessionProvider initialSession={authSession}>
            <MemoryRouter initialEntries={[path]}>
              <Routes>{appRoutes}</Routes>
            </MemoryRouter>
          </SessionProvider>
        </ConfirmProvider>
      </ToastProvider>
    </ThemeProvider>
    </React.Fragment>,
  );
}

test("authenticated shell exposes identity, logout, and admin-only operator navigation", () => {
  const html = renderRoute("/operators", session("admin"));

  assert.match(html, /Morgan Scout/);
  assert.match(html, /Administrator/);
  assert.match(html, />Sign out</);
  assert.match(html, /href="\/operators"/);
  assert.match(html, /Operator access/);
});

test("data operators do not receive administrator navigation", () => {
  const html = renderRoute("/", session("data_operator"));

  assert.match(html, /Data operator/);
  assert.doesNotMatch(html, /href="\/operators"/);
  assert.doesNotMatch(html, /href="\/users"/);
  assert.match(html, /href="\/providers"/);
  assert.match(html, /aria-label="Admin navigation"/);
});

test("administrators reach the product-user directory from the workspace navigation", () => {
  const html = renderRoute("/users", session("admin"));

  assert.match(html, /href="\/users"/);
  assert.match(html, /Product users/);
  assert.match(html, /Search email, wallet address, or subject key/);
});

test("data operators can open provider health without receiving mutation controls", () => {
  const html = renderRoute("/providers", session("data_operator"));

  assert.match(html, /Data providers/);
  assert.match(html, /Read-only access/);
  assert.doesNotMatch(html, /Add provider/);
});

test("data operators receive pipeline status, run, quarantine, and alert navigation", () => {
  const html = renderRoute("/runs", session("data_operator"));

  assert.match(html, /Data pipeline/);
  assert.match(html, /href="\/operations"/);
  assert.match(html, /href="\/runs"/);
  assert.match(html, /href="\/quarantine"/);
  assert.match(html, /href="\/alerts"/);
  assert.match(html, /Import runs/);
  assert.doesNotMatch(html, /href="\/operators"/);
});

test("both operator roles reach the worker fleet under the pipeline view permission", () => {
  for (const role of ["admin", "data_operator"] as const) {
    const html = renderRoute("/workers", session(role));

    assert.match(html, /href="\/workers"/);
    assert.match(html, /Worker fleet/);
    assert.match(html, /Data pipeline \/ Workers/);
  }
});

test("message-delivery navigation is administrator-only", () => {
  const adminHtml = renderRoute("/messages", session("admin"));
  assert.match(adminHtml, /href="\/messages"/);
  assert.match(adminHtml, /Message delivery/);

  const dataOperatorHtml = renderRoute("/", session("data_operator"));
  assert.doesNotMatch(dataOperatorHtml, /href="\/messages"/);
});
