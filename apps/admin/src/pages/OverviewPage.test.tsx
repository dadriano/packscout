import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { SessionProvider } from "../providers/session.tsx";
import { ToastProvider } from "../providers/toast.tsx";
import { OverviewPage } from "./OverviewPage.tsx";

test("admin overview renders protected data-operations state", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <ToastProvider>
        <SessionProvider
          initialSession={{
            operator: {
              id: "00000000-0000-4000-8000-000000000001",
              email: "admin@packscout.test",
              displayName: "Primary Admin",
              state: "active",
            },
            membership: {
              organizationId: "00000000-0000-4000-8000-000000000010",
              organizationName: "PackScout",
              role: "admin",
            },
            permissions: ["operators:manage"],
            csrfToken: "fixture-csrf",
          }}
        >
          <OverviewPage />
        </SessionProvider>
      </ToastProvider>
    </MemoryRouter>,
  );

  // The overview carries exactly two things: a live service reading and the
  // next step. Everything it shows must reflect current state, so the page
  // holds no fixed copy asserting the codebase's own properties.
  assert.match(html, /aria-label="Service status"/);
  assert.match(html, /Admin service/);
  assert.match(html, /disabled=""[^>]*>Checking service/);
  assert.doesNotMatch(html, /Guardrails carried forward|Zero accepted drift/);
  assert.doesNotMatch(html, /What the base does not pretend/);
  // The overview's one forward step: name the next task and route to it.
  assert.match(html, /Set up your first provider/);
  assert.match(html, /href="\/providers"[^>]*>Go to providers/);
});
