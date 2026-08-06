import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionProvider } from "../providers/session.tsx";
import { ToastProvider } from "../providers/toast.tsx";
import { OverviewPage } from "./OverviewPage.tsx";

test("admin overview renders protected data-operations state", () => {
  const html = renderToStaticMarkup(
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
    </ToastProvider>,
  );

  assert.match(html, /Data operations, under control/);
  assert.match(html, /Guardrails carried forward/);
  assert.match(html, /Authentication/);
  assert.match(html, /Session protected/);
  assert.match(html, /Persistence/);
  assert.match(html, /PostgreSQL owned/);
  assert.match(html, /aria-label="Foundation status"/);
  assert.match(html, /disabled=""[^>]*>Checking service/);
});
