import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AuthSessionResponse,
  DirectProvisionOperatorResponse,
  OperatorSummary,
} from "@packscout/contracts";
import { act } from "react";
import * as React from "react";
import { MemoryRouter } from "react-router-dom";
import { ConfirmProvider } from "../providers/confirm.tsx";
import { SessionProvider } from "../providers/session.tsx";
import { ToastProvider } from "../providers/toast.tsx";
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
import { OperatorsPage } from "./OperatorsPage.tsx";

const admin: OperatorSummary = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "admin@packscout.test",
  displayName: "Primary Admin",
  state: "active",
  role: "admin",
  createdAt: "2026-08-25T10:00:00.000Z",
  updatedAt: "2026-08-25T10:00:00.000Z",
  lastAccessAt: null,
};
const direct: OperatorSummary = {
  ...admin,
  id: "00000000-0000-4000-8000-000000000002",
  email: "direct@packscout.test",
  displayName: "Direct Operator",
  role: "data_operator",
};
const session: AuthSessionResponse = {
  operator: {
    id: admin.id,
    email: admin.email,
    displayName: admin.displayName,
    state: "active",
  },
  membership: {
    organizationId: "00000000-0000-4000-8000-000000000010",
    organizationName: "PackScout",
    role: "admin",
  },
  permissions: ["operators:manage"],
  csrfToken: "csrf-token",
};
const initialPassword = "an initial secure password";

function page() {
  Object.assign(globalThis, { React });
  return (
    <ToastProvider>
      <SessionProvider initialSession={session}>
        <ConfirmProvider>
          <MemoryRouter initialEntries={["/operators"]}>
            <OperatorsPage />
          </MemoryRouter>
        </ConfirmProvider>
      </SessionProvider>
    </ToastProvider>
  );
}

async function submitDirectCreation(
  renderer: Awaited<ReturnType<typeof renderPage>>,
): Promise<void> {
  await act(async () => findButton(renderer, "Create with password").click());
  await act(async () =>
    changeControl(renderer, "operator-display-name", direct.displayName),
  );
  await act(async () => changeControl(renderer, "operator-email", direct.email));
  await act(async () =>
    changeControl(renderer, "operator-password", initialPassword),
  );
  await act(async () => findButton(renderer, "Create account").click());
  await settlePage();
}

function stubOperators(
  context: Parameters<typeof stubFetch>[0],
  response: DirectProvisionOperatorResponse,
) {
  return stubFetch(context, ({ input, init }) => {
    const url = String(input);
    if (url.endsWith("/operators") && (init?.method ?? "GET") === "GET") {
      return jsonResponse({ items: [admin], nextCursor: null });
    }
    if (url.endsWith("/operators/direct") && init?.method === "POST") {
      return jsonResponse(response, 201);
    }
    throw new Error(`Unexpected request: ${url}`);
  });
}

test("admins can create an active operator and see that its email was queued", async (context) => {
  const response: DirectProvisionOperatorResponse = {
    operator: direct,
    notification: { status: "enqueued", deduplicated: false },
  };
  const requests = stubOperators(context, response);
  const renderer = await renderPage(page());
  cleanupPage(context, renderer);
  await settlePage();

  assert.ok(findButton(renderer, "Invite operator"));
  assert.ok(findButton(renderer, "Create with password"));
  await submitDirectCreation(renderer);

  const mutation = requests.find(({ input }) =>
    String(input).endsWith("/operators/direct"),
  );
  assert.ok(mutation);
  assert.deepEqual(JSON.parse(String(mutation.init?.body)), {
    email: direct.email,
    displayName: direct.displayName,
    password: initialPassword,
    role: "data_operator",
  });
  const text = pageText(renderer);
  assert.match(text, /Direct Operator/);
  assert.match(text, /Active/);
  assert.match(text, /Account email queued/);
  assert.match(text, /share the initial password separately/);
  assert.doesNotMatch(text, /an initial secure password/);
  assert.doesNotMatch(renderer.container.innerHTML, /an initial secure password/);
});

test("a notification failure still closes the dialog and says the account exists", async (context) => {
  stubOperators(context, {
    operator: direct,
    notification: {
      status: "failed",
      reason: "EMAIL_OUTBOX_SOURCE_BACKLOG_EXCEEDED",
    },
  });
  const renderer = await renderPage(page());
  cleanupPage(context, renderer);
  await settlePage();

  await submitDirectCreation(renderer);

  const text = pageText(renderer);
  assert.match(text, /Direct Operator can now sign in/);
  assert.match(text, /account email was not queued/);
  assert.match(text, /Share the sign-in details and initial password/);
  assert.equal(
    renderer.container.querySelector('[role="dialog"]'),
    null,
  );
  assert.doesNotMatch(text, /EMAIL_OUTBOX_SOURCE_BACKLOG_EXCEEDED/);
  assert.doesNotMatch(renderer.container.innerHTML, /an initial secure password/);
});

test("an ambiguous direct-create failure reconciles the ledger without inviting a retry", async (context) => {
  let listCount = 0;
  stubFetch(context, ({ input, init }) => {
    const url = String(input);
    if (url.endsWith("/operators") && (init?.method ?? "GET") === "GET") {
      listCount += 1;
      return jsonResponse({
        items: listCount === 1 ? [admin] : [direct, admin],
        nextCursor: null,
      });
    }
    if (url.endsWith("/operators/direct") && init?.method === "POST") {
      throw new TypeError("network connection closed after sending request");
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  const renderer = await renderPage(page());
  cleanupPage(context, renderer);
  await settlePage();

  await submitDirectCreation(renderer);
  await settlePage();

  const text = pageText(renderer);
  assert.equal(listCount, 2);
  assert.match(text, /could not confirm whether the account was created/);
  assert.match(text, /Check the operators list and Messages before trying again/);
  assert.match(text, /Direct Operator/);
  assert.doesNotMatch(text, /Your account has not been changed/);
  assert.equal(renderer.container.querySelector('[role="dialog"]'), null);
  assert.doesNotMatch(text, /an initial secure password/);
  assert.doesNotMatch(renderer.container.innerHTML, /an initial secure password/);
});

test("an unavailable email outbox is reported as unconfirmed", async (context) => {
  stubOperators(context, {
    operator: direct,
    notification: {
      status: "failed",
      reason: "EMAIL_OUTBOX_UNAVAILABLE",
    },
  });
  const renderer = await renderPage(page());
  cleanupPage(context, renderer);
  await settlePage();

  await submitDirectCreation(renderer);

  const text = pageText(renderer);
  assert.match(text, /Direct Operator can now sign in/);
  assert.match(text, /email queueing could not be confirmed/);
  assert.match(text, /Check Messages/);
  assert.doesNotMatch(text, /account email was not queued/);
  assert.doesNotMatch(renderer.container.innerHTML, /an initial secure password/);
});
