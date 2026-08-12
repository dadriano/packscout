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
