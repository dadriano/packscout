import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ToastProvider } from "../providers/toast.tsx";
import { OverviewPage } from "./OverviewPage.tsx";

test("admin overview renders the foundation state without claiming deferred systems", () => {
  const html = renderToStaticMarkup(
    <ToastProvider>
      <OverviewPage />
    </ToastProvider>,
  );

  assert.match(html, /A clean base for the work ahead/);
  assert.match(html, /Guardrails carried forward/);
  assert.match(html, /Authentication/);
  assert.match(html, /Not configured/);
  assert.match(html, /Persistence/);
  assert.match(html, /Not selected/);
  assert.match(html, /aria-label="Foundation status"/);
  assert.match(html, /disabled=""[^>]*>Checking service/);
});
