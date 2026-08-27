import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import {
  cleanupPage,
  pageText,
  renderPage,
  settlePage,
  stubFetch,
} from "../testing/react-page-test.tsx";
import { ProviderFormPage } from "./ProviderFormPage.tsx";

function route(path: string) {
  return (
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/providers/new" element={<ProviderFormPage />} />
        <Route path="/providers/:providerId/edit" element={<ProviderFormPage />} />
        <Route
          path="/source-configuration"
          element={<p>Provider Sources destination</p>}
        />
      </Routes>
    </MemoryRouter>
  );
}

for (const path of [
  "/providers/new",
  "/providers/00000000-0000-4000-8000-000000000020/edit",
]) {
  test(`legacy provider configuration route ${path} redirects without issuing a mutation`, async (context) => {
    const requests = stubFetch(context, () => {
      throw new Error("A retired provider route attempted an HTTP request.");
    });
    const renderer = await renderPage(route(path));
    cleanupPage(context, renderer);
    await settlePage();

    assert.match(pageText(renderer), /Provider Sources destination/);
    assert.equal(requests.length, 0);
    assert.equal(renderer.container.querySelector("form"), null);
  });
}
