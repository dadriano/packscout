import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AuthSessionResponse,
  MessageDeliveryCounts,
  MessageDeliveryIntentRow,
  OperatorPermission,
} from "@packscout/contracts";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { SessionProvider } from "../providers/session.tsx";
import { ToastProvider } from "../providers/toast.tsx";
import {
  changeControl,
  cleanupPage,
  deferred,
  jsonResponse,
  pageText,
  renderPage,
  settlePage,
  stubFetch,
  type RecordedRequest,
} from "../testing/react-page-test.tsx";
import { MessagesPage } from "./MessagesPage.tsx";

const failedRow: MessageDeliveryIntentRow = {
  intentId: "b6f6f4a0-3a89-4a90-8f6e-6a1d2c3b4a5f",
  kind: "access_approved",
  recipient: "ada@example.test",
  source: "closed_beta",
  state: "failed",
  attemptCount: 3,
  createdAt: "2026-08-23T07:00:00.000Z",
  dueAt: "2026-08-23T08:00:00.000Z",
  lastAttemptedAt: "2026-08-23T08:05:00.000Z",
  lastProvider: "postmark",
  lastErrorCode: "EMAIL_POSTMARK_TRANSPORT_FAILED",
  lastSkipReason: null,
  finalizedAt: "2026-08-23T08:05:00.000Z",
};
const sentRow: MessageDeliveryIntentRow = {
  ...failedRow,
  intentId: "0f0e0d0c-0b0a-4a90-8f6e-6a1d2c3b4a50",
  kind: "welcome",
  recipient: "grace@example.test",
  state: "sent",
  attemptCount: 1,
  lastErrorCode: null,
  createdAt: "2026-08-23T06:00:00.000Z",
};

const counts: MessageDeliveryCounts = {
  pending: 4,
  retrying: 2,
  due: 1,
  claimed: 1,
  failed: 6,
  sent: 120,
  skipped: 3,
  oldestDueAt: "2026-08-23T08:30:00.000Z",
};

const administrator: readonly OperatorPermission[] = [
  "message_delivery:view",
  "message_delivery:manage",
];

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
      role: "admin",
    },
    permissions: [...permissions],
    csrfToken: "csrf-test-token",
  };
}

function route(permissions: readonly OperatorPermission[] = administrator) {
  return (
    <ToastProvider>
      <SessionProvider initialSession={session(permissions)}>
        <MemoryRouter initialEntries={["/messages"]}>
          <MessagesPage />
        </MemoryRouter>
      </SessionProvider>
    </ToastProvider>
  );
}

function body({ init }: RecordedRequest): Record<string, unknown> {
  return JSON.parse(String(init?.body ?? "{}"));
}

/** Answers /list and /counts; everything else is unexpected. */
function stubHistory(
  items: readonly MessageDeliveryIntentRow[],
  queueCounts: MessageDeliveryCounts = counts,
) {
  return ({ input }: RecordedRequest) => {
    const url = String(input);
    if (url.endsWith("/messages/list")) {
      return jsonResponse({ items, nextCursor: null });
    }
    if (url.endsWith("/messages/counts")) {
      return jsonResponse(queueCounts);
    }
    throw new Error(`Unexpected request: ${url}`);
  };
}

async function applyFilters(
  renderer: Awaited<ReturnType<typeof renderPage>>,
): Promise<void> {
  await act(async () => {
    const form = renderer.container.querySelector<HTMLFormElement>(
      'form[aria-label="Filter the delivery history"]',
    );
    if (!form) throw new Error("The delivery filter form was not found.");
    form.dispatchEvent(
      new renderer.dom.window.Event("submit", { bubbles: true, cancelable: true }),
    );
  });
  await settlePage();
}

test("the history lists intents with recipient, kind, state, and error facts, and counts at a glance", async (context) => {
  const load = deferred<Response>();
  stubFetch(context, ({ input }) => {
    const url = String(input);
    if (url.endsWith("/messages/counts")) return jsonResponse(counts);
    return load.promise;
  });

  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  assert.match(pageText(renderer), /Loading the delivery history/);

  load.resolve(jsonResponse({ items: [failedRow, sentRow], nextCursor: null }));
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /ada@example\.test/);
  assert.match(text, /grace@example\.test/);
  assert.match(text, /Beta access approved/);
  assert.match(text, /Welcome/);
  assert.match(text, /Failed/);
  assert.match(text, /Sent/);
  assert.match(text, /EMAIL_POSTMARK_TRANSPORT_FAILED/);
  assert.match(text, /postmark/);
  // The queue-state counts are visible without paging the list.
  assert.match(text, /Pending 4/);
  assert.match(text, /Retrying 2/);
  assert.match(text, /Failed 6/);
});

test("no message content renders, even when a response smuggles body-like fields", async (context) => {
  const poisonedRows = [
    {
      ...failedRow,
      body: "Dear Ada BODY-MARKER",
      subject: "SUBJECT-MARKER",
      inputJson: { textBody: "INPUT-MARKER" },
    },
  ] as unknown as MessageDeliveryIntentRow[];
  stubFetch(context, stubHistory(poisonedRows));

  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /ada@example\.test/);
  // The page renders only the closed row projection; a smuggled body,
  // subject, or rendering input has nowhere to appear.
  assert.doesNotMatch(text, /BODY-MARKER|SUBJECT-MARKER|INPUT-MARKER/);
  assert.doesNotMatch(renderer.container.innerHTML, /BODY-MARKER|SUBJECT-MARKER|INPUT-MARKER/);
});

test("a recipient search travels in the request body and never reaches a URL", async (context) => {
  const requests = stubFetch(context, stubHistory([failedRow]));

  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  await act(async () =>
    changeControl(renderer, "messages-recipient", "ada@example.test"),
  );
  await applyFilters(renderer);

  const listRequests = requests.filter(({ input }) =>
    String(input).endsWith("/messages/list"),
  );
  const searched = listRequests.at(-1);
  assert.ok(searched);
  assert.equal(body(searched).recipient, "ada@example.test");
  // No request URL carries a query string, and the page's own address —
  // what browser history records — never changes or names an address.
  for (const { input } of requests) {
    assert.doesNotMatch(String(input), /[?#]|ada|example\.test/);
  }
  assert.equal(renderer.dom.window.location.href, "https://admin.packscout.test/");

  // A fragment of an address refuses locally rather than searching.
  await act(async () => changeControl(renderer, "messages-recipient", "ad"));
  const requestCount = requests.length;
  await applyFilters(renderer);
  assert.match(pageText(renderer), /Enter the full recipient address\./);
  assert.equal(requests.length, requestCount);
});

test("state and kind filters are applied and a no-match state clears back", async (context) => {
  let filtered = false;
  const requests = stubFetch(context, (request) => {
    const url = String(request.input);
    if (url.endsWith("/messages/counts")) return jsonResponse(counts);
    const parsed = body(request);
    filtered = parsed.state === "failed" && parsed.kind === "welcome";
    return jsonResponse({ items: filtered ? [] : [failedRow], nextCursor: null });
  });

  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  await act(async () => changeControl(renderer, "messages-state", "failed"));
  await act(async () => changeControl(renderer, "messages-kind", "welcome"));
  await applyFilters(renderer);

  assert.equal(filtered, true);
  assert.match(pageText(renderer), /No delivery records match these filters\./);

  // Clearing the filters returns to the whole history.
  const clear = [...renderer.container.querySelectorAll("button")].find(
    (button) => button.textContent === "Clear filters",
  );
  assert.ok(clear);
  await act(async () => {
    clear.dispatchEvent(
      new renderer.dom.window.MouseEvent("click", { bubbles: true }),
    );
  });
  await settlePage();
  assert.match(pageText(renderer), /ada@example\.test/);
  const finalList = requests
    .filter(({ input }) => String(input).endsWith("/messages/list"))
    .at(-1);
  assert.ok(finalList);
  assert.deepEqual(body(finalList), { limit: 20 });
});

test("a true-empty history explains itself", async (context) => {
  stubFetch(
    context,
    stubHistory([], { ...counts, pending: 0, retrying: 0, failed: 0, sent: 0 }),
  );

  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  assert.match(pageText(renderer), /No messages have been queued yet\./);
});

test("unavailable delivery records degrade to a bounded error with retry", async (context) => {
  let failing = true;
  stubFetch(context, ({ input }) => {
    if (failing) {
      return jsonResponse(
        { error: "The message delivery records are temporarily unavailable.", code: "MESSAGE_DELIVERY_UNAVAILABLE" },
        503,
      );
    }
    return stubHistory([failedRow])({ input, init: undefined });
  });

  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /temporarily unavailable/);
  assert.match(text, /Nothing has been changed/);
  // No backend detail beyond the fixed copy is shown.
  assert.doesNotMatch(text, /ECONNREFUSED|postgres|stack/i);

  failing = false;
  const retry = [...renderer.container.querySelectorAll("button")].find(
    (button) => button.textContent === "Try again",
  );
  assert.ok(retry);
  await act(async () => {
    retry.dispatchEvent(
      new renderer.dom.window.MouseEvent("click", { bubbles: true }),
    );
  });
  await settlePage();
  assert.match(pageText(renderer), /ada@example\.test/);
});

test("an operator without the view permission sees the restricted state", async (context) => {
  stubFetch(context, () =>
    jsonResponse(
      {
        error: "You do not have permission to perform this action.",
        code: "FORBIDDEN",
      },
      403,
    ),
  );

  const renderer = await renderPage(route(["providers:view"] as const));
  cleanupPage(context, renderer);
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /limited to administrators/);
  assert.match(text, /does not include permission to view message delivery/);
});
