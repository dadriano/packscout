import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AuthSessionResponse,
  MessageDeliveryDetail,
  OperatorPermission,
} from "@packscout/contracts";
import { act } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { setAdminCsrfToken } from "../api/client.ts";
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
import { MessageDetailPage } from "./MessageDetailPage.tsx";

const intentId = "b6f6f4a0-3a89-4a90-8f6e-6a1d2c3b4a5f";

const failedDetail: MessageDeliveryDetail = {
  intent: {
    intentId,
    kind: "access_approved",
    recipient: "ada@example.test",
    source: "closed_beta",
    state: "failed",
    attemptCount: 2,
    createdAt: "2026-08-23T07:00:00.000Z",
    dueAt: "2026-08-23T08:00:00.000Z",
    lastAttemptedAt: "2026-08-23T08:05:00.000Z",
    lastProvider: "postmark",
    lastErrorCode: "EMAIL_POSTMARK_TRANSPORT_FAILED",
    lastSkipReason: null,
    finalizedAt: "2026-08-23T08:05:00.000Z",
  },
  attempts: [
    {
      attemptNumber: 1,
      attemptedAt: "2026-08-23T07:01:00.000Z",
      outcome: "failed",
      provider: "postmark",
      providerMessageId: null,
      errorCode: "EMAIL_POSTMARK_TRANSPORT_FAILED",
      errorMessage: "Provider connection reset.",
      skipReason: null,
    },
    {
      attemptNumber: 2,
      attemptedAt: "2026-08-23T08:05:00.000Z",
      outcome: "sent",
      provider: "postmark",
      providerMessageId: "pm-message-0002",
      errorCode: null,
      errorMessage: null,
      skipReason: null,
    },
  ],
};

const administrator: readonly OperatorPermission[] = [
  "message_delivery:view",
  "message_delivery:manage",
];
/** A viewer holds the read permission and not the retry control. */
const viewer: readonly OperatorPermission[] = ["message_delivery:view"];

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
      <ConfirmProvider>
        <SessionProvider initialSession={session(permissions)}>
          <MemoryRouter initialEntries={[`/messages/${intentId}`]}>
            <Routes>
              <Route path="/messages/:intentId" element={<MessageDetailPage />} />
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

test("the detail shows the attempt history with provider evidence to correlate on", async (context) => {
  stubFetch(context, () => jsonResponse(failedDetail));

  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /ada@example\.test/);
  assert.match(text, /Beta access approved/);
  assert.match(text, /closed_beta/);
  // Each attempt carries its time, provider, outcome, and stable error code;
  // the success carries the provider's own message identifier.
  assert.match(text, /EMAIL_POSTMARK_TRANSPORT_FAILED/);
  assert.match(text, /Provider connection reset\./);
  assert.match(text, /pm-message-0002/);
  assert.match(text, /postmark/);
  const attemptRows = renderer.container.querySelectorAll(
    ".messages-attempts tbody tr",
  );
  assert.equal(attemptRows.length, 2);
});

test("no message content renders, even when a response smuggles body-like fields", async (context) => {
  const poisoned = {
    intent: {
      ...failedDetail.intent,
      body: "Dear Ada BODY-MARKER",
      subject: "SUBJECT-MARKER",
    },
    attempts: [
      { ...failedDetail.attempts[0], renderedBody: "ATTEMPT-BODY-MARKER" },
    ],
  } as unknown as MessageDeliveryDetail;
  stubFetch(context, () => jsonResponse(poisoned));

  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  assert.match(pageText(renderer), /ada@example\.test/);
  assert.doesNotMatch(
    renderer.container.innerHTML,
    /BODY-MARKER|SUBJECT-MARKER|ATTEMPT-BODY-MARKER/,
  );
});

test("a terminally failed delivery is retried with explicit confirmation and re-enters the queue", async (context) => {
  // The real session bootstrap registers the CSRF token with the API client;
  // the test session registers it the same way so the retry can carry it.
  setAdminCsrfToken("csrf-test-token");
  context.after(() => setAdminCsrfToken(null));
  const requests = stubFetch(context, ({ input }) => {
    if (String(input).endsWith("/messages/retry")) {
      return jsonResponse({
        intent: {
          ...failedDetail.intent,
          state: "pending",
          dueAt: "2026-08-23T09:00:00.000Z",
          finalizedAt: null,
        },
      });
    }
    return jsonResponse(failedDetail);
  });

  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  await act(async () => {
    findButton(renderer, "Retry delivery").dispatchEvent(
      new renderer.dom.window.MouseEvent("click", { bubbles: true }),
    );
  });

  // The confirmation names the consequence before anything happens: the
  // message re-enters the queue, bounded, and nothing sends inline.
  const dialogText = pageText(renderer);
  assert.match(dialogText, /Retry this delivery\?/);
  assert.match(dialogText, /re-enters the delivery queue/);
  assert.match(dialogText, /one more bounded attempt/);
  assert.equal(
    requests.some(({ input }) => String(input).endsWith("/messages/retry")),
    false,
  );

  await act(async () => {
    findButton(renderer, "Retry delivery", 1).dispatchEvent(
      new renderer.dom.window.MouseEvent("click", { bubbles: true }),
    );
  });
  await settlePage();
  await settlePage();

  const retry = requests.find(({ input }) =>
    String(input).endsWith("/messages/retry"),
  );
  assert.ok(retry, "the retry was requested");
  assert.deepEqual(body(retry), { intentId });
  assert.equal(
    new Headers(retry.init?.headers).get("X-CSRF-Token"),
    "csrf-test-token",
  );
  const text = pageText(renderer);
  assert.match(text, /Message queued for delivery again\./);
  assert.match(text, /Pending/);
});

test("a refused retry reports the queue's answer and reloads the record", async (context) => {
  const requests = stubFetch(context, ({ input }) => {
    if (String(input).endsWith("/messages/retry")) {
      return jsonResponse(
        {
          error:
            "This message is already queued for delivery, so there is nothing to retry.",
          code: "MESSAGE_DELIVERY_RETRY_NOT_TERMINAL",
          state: "pending",
        },
        409,
      );
    }
    return jsonResponse(failedDetail);
  });

  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();

  await act(async () => {
    findButton(renderer, "Retry delivery").dispatchEvent(
      new renderer.dom.window.MouseEvent("click", { bubbles: true }),
    );
  });
  await act(async () => {
    findButton(renderer, "Retry delivery", 1).dispatchEvent(
      new renderer.dom.window.MouseEvent("click", { bubbles: true }),
    );
  });
  await settlePage();
  await settlePage();

  assert.match(pageText(renderer), /already queued for delivery/);
  // The page reloads the record: the refusal knows the current truth.
  const detailLoads = requests.filter(({ input }) =>
    String(input).endsWith("/messages/detail"),
  );
  assert.equal(detailLoads.length, 2);
});

test("the retry control is absent without the manage permission and for non-failed intents", async (context) => {
  stubFetch(context, () => jsonResponse(failedDetail));
  const viewerRenderer = await renderPage(route(viewer));
  cleanupPage(context, viewerRenderer);
  await settlePage();
  assert.match(pageText(viewerRenderer), /ada@example\.test/);
  assert.equal(
    [...viewerRenderer.container.querySelectorAll("button")].some(
      (button) => button.textContent === "Retry delivery",
    ),
    false,
  );
});

test("a delivered intent offers no retry even to managers", async (context) => {
  stubFetch(context, () =>
    jsonResponse({
      ...failedDetail,
      intent: { ...failedDetail.intent, state: "sent", lastErrorCode: null },
    }),
  );
  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  await settlePage();
  assert.match(pageText(renderer), /Sent/);
  assert.equal(
    [...renderer.container.querySelectorAll("button")].some(
      (button) => button.textContent === "Retry delivery",
    ),
    false,
  );
});

test("a vanished record and unavailable records degrade to clear states", async (context) => {
  stubFetch(context, () =>
    jsonResponse(
      {
        error: "This delivery record no longer exists.",
        code: "MESSAGE_DELIVERY_INTENT_NOT_FOUND",
      },
      404,
    ),
  );
  const missingRenderer = await renderPage(route());
  cleanupPage(context, missingRenderer);
  await settlePage();
  assert.match(
    pageText(missingRenderer),
    /This delivery record no longer exists\./,
  );
});

test("unavailable delivery records show a retryable, non-destructive error", async (context) => {
  const load = deferred<Response>();
  stubFetch(context, () => load.promise);

  const renderer = await renderPage(route());
  cleanupPage(context, renderer);
  assert.match(pageText(renderer), /Loading the delivery record/);

  load.resolve(
    jsonResponse(
      {
        error: "The message delivery records are temporarily unavailable.",
        code: "MESSAGE_DELIVERY_UNAVAILABLE",
      },
      503,
    ),
  );
  await settlePage();

  const text = pageText(renderer);
  assert.match(text, /temporarily unavailable/);
  assert.match(text, /Nothing has been changed/);
  assert.ok(findButton(renderer, "Try again"));
});
