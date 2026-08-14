import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuthSessionResponse, ProviderConfigurationSummary } from "@packscout/contracts";
import { act } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { SessionProvider } from "../providers/session.tsx";
import { ToastProvider } from "../providers/toast.tsx";
import {
  changeControl,
  cleanupPage,
  jsonResponse,
  pageText,
  renderPage,
  settlePage,
  stubFetch,
} from "../testing/react-page-test.tsx";
import { ProviderFormPage } from "./ProviderFormPage.tsx";

const provider: ProviderConfigurationSummary = {
  id: "00000000-0000-4000-8000-000000000020",
  platformKey: "fanatics",
  displayName: "Fanatics cards",
  state: "draft",
  latestRevision: {
    id: "00000000-0000-4000-8000-000000000021",
    version: 1,
    adapterKey: "http-cursor-v2",
    endpoint: "https://feed.packscout.test/cards",
    endpointHost: "feed.packscout.test",
    authMode: "none",
    hasBearerSecret: false,
    scheduleSeconds: 300,
    staleAfterSeconds: 900,
    testedAt: null,
    createdAt: "2026-08-06T12:00:00.000Z",
    lastConnectionTest: null,
  },
  activeRevisionId: null,
  nextRunAt: null,
  createdAt: "2026-08-06T12:00:00.000Z",
  updatedAt: "2026-08-06T12:00:00.000Z",
};

function session(canManage: boolean): AuthSessionResponse {
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
      role: canManage ? "admin" : "data_operator",
    },
    permissions: canManage ? ["providers:view", "providers:manage"] : ["providers:view"],
    csrfToken: "csrf-test-token",
  };
}

function route(path: string, authSession: AuthSessionResponse) {
  return (
    <ToastProvider>
      <SessionProvider initialSession={authSession}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/providers/new" element={<ProviderFormPage />} />
            <Route path="/providers/:providerId/edit" element={<ProviderFormPage />} />
            <Route path="/providers/:providerId" element={<p>Saved provider detail</p>} />
            <Route path="/providers" element={<p>Provider ledger destination</p>} />
          </Routes>
        </MemoryRouter>
      </SessionProvider>
    </ToastProvider>
  );
}

test("provider form redirects a read-only operator before exposing configuration controls", async (context) => {
  const renderer = await renderPage(route("/providers/new", session(false)));
  cleanupPage(context, renderer);

  assert.match(pageText(renderer), /Provider ledger destination/);
  assert.doesNotMatch(pageText(renderer), /Create data provider|Bearer token|Endpoint/);
});

test("provider form creates a draft from normalized form values and navigates to its detail", async (context) => {
  const requests = stubFetch(context, ({ input, init }) => {
    assert.equal(String(input), "/api/data-providers");
    assert.equal(init?.method, "POST");
    return jsonResponse({ provider });
  });
  const renderer = await renderPage(route("/providers/new", session(true)));
  cleanupPage(context, renderer);

  await act(async () => {
    changeControl(renderer, "provider-name", "Fanatics cards");
    changeControl(renderer, "provider-platform", "fanatics");
    changeControl(renderer, "provider-adapter", "http-cursor-v2");
    changeControl(renderer, "provider-endpoint", "https://feed.packscout.test/cards");
  });
  assert.match(pageText(renderer), /Unsaved changes/);

  await act(async () => {
    const form = renderer.container.querySelector<HTMLFormElement>('form[aria-label="Create data provider"]');
    if (!form) throw new Error("Create provider form not found.");
    form.dispatchEvent(new renderer.dom.window.Event("submit", {
      bubbles: true,
      cancelable: true,
    }));
  });
  await settlePage();

  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    displayName: "Fanatics cards",
    platformKey: "fanatics",
    adapterKey: "http-cursor-v2",
    endpoint: "https://feed.packscout.test/cards",
    auth: { mode: "none" },
    scheduleSeconds: 300,
    staleAfterSeconds: 900,
  });
  assert.match(pageText(renderer), /Saved provider detail/);
  assert.match(pageText(renderer), /Fanatics cards created as a draft/);
});

test("provider revision load failure remains visible after loading ends", async (context) => {
  stubFetch(context, () => jsonResponse({
    error: "Your role no longer permits provider changes.",
    code: "FORBIDDEN",
  }, 403));
  const renderer = await renderPage(route(`/providers/${provider.id}/edit`, session(true)));
  cleanupPage(context, renderer);

  assert.match(pageText(renderer), /Your role no longer permits provider changes/);
  assert.match(pageText(renderer), /Return to providers/);
  assert.doesNotMatch(pageText(renderer), /Loading masked configuration/);
});
