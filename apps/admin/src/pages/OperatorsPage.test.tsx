import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { OperatorLedger } from "../components/auth/OperatorLedger.tsx";

const operator = {
  id: "00000000-0000-4000-8000-000000000002",
  email: "operator@packscout.test",
  displayName: "Data Operator",
  state: "active" as const,
  role: "data_operator" as const,
  createdAt: "2026-08-06T12:00:00.000Z",
  updatedAt: "2026-08-06T12:00:00.000Z",
  lastAccessAt: null,
};

test("operator ledger exposes literal role, state, and labelled account actions", () => {
  Object.assign(globalThis, { React });
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <OperatorLedger
        operators={[operator]}
        currentOperatorId={operator.id}
        onChangeRole={() => undefined}
        onRotateCredential={() => undefined}
        onToggleState={() => undefined}
        onReissueInvitation={() => undefined}
        onCancelInvitation={() => undefined}
      />
    </MemoryRouter>,
  );

  assert.match(html, /Data Operator \(you\)/);
  assert.match(html, /Data operator/);
  assert.match(html, />Active</);
  assert.match(html, />Change role</);
  assert.match(html, />Rotate credential</);
  assert.match(html, />Disable access</);
  assert.match(html, /aria-labelledby="operators-ledger-title"/);
});

test("the ledger distinguishes pending, expired-invitation, and cancelled from enabled and disabled", () => {
  Object.assign(globalThis, { React });
  const pending = {
    ...operator,
    id: "00000000-0000-4000-8000-000000000003",
    displayName: "Invited Operator",
    state: "pending" as const,
    invitation: {
      sentAt: "2026-08-23T12:00:00.000Z",
      expiresAt: "2026-08-30T12:00:00.000Z",
      expired: false,
    },
  };
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <OperatorLedger
        operators={[
          operator,
          { ...operator, id: "d", state: "disabled" as const },
          pending,
          {
            ...pending,
            id: "e",
            invitation: { ...pending.invitation, expired: true },
          },
          { ...operator, id: "c", state: "cancelled" as const },
        ]}
        currentOperatorId={operator.id}
        onChangeRole={() => undefined}
        onRotateCredential={() => undefined}
        onToggleState={() => undefined}
        onReissueInvitation={() => undefined}
        onCancelInvitation={() => undefined}
      />
    </MemoryRouter>,
  );

  // Five accounts, five distinguishable readings.
  assert.match(html, />Active</);
  assert.match(html, />Disabled</);
  assert.match(html, />Invitation sent</);
  assert.match(html, />Invitation expired</);
  assert.match(html, />Cancelled</);
  // A pending account offers invitation controls, not account controls.
  assert.match(html, />Resend invitation</);
  assert.match(html, />Cancel invitation</);
  assert.match(html, /link valid until/);
  assert.match(html, /link expired/);
  // Never a token, a link, or credential material.
  assert.doesNotMatch(html, /accept-invitation|token|password/i);
});

test("a pending account whose invitation was withdrawn reads as such", () => {
  Object.assign(globalThis, { React });
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <OperatorLedger
        operators={[{ ...operator, state: "pending" as const, invitation: null }]}
        currentOperatorId=""
        onChangeRole={() => undefined}
        onRotateCredential={() => undefined}
        onToggleState={() => undefined}
        onReissueInvitation={() => undefined}
        onCancelInvitation={() => undefined}
      />
    </MemoryRouter>,
  );
  assert.match(html, />Invitation withdrawn</);
  assert.match(html, /No invitation outstanding/);
});
