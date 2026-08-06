import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AdminDialog } from "./AdminDialog.tsx";

test("admin dialog exposes a labelled modal and an accessible close control", () => {
  const html = renderToStaticMarkup(
    <AdminDialog
      open
      title="Confirm route change"
      description="Unsaved work will be discarded."
      onClose={() => undefined}
    >
      <p>Dialog body</p>
    </AdminDialog>,
  );

  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /aria-labelledby=/);
  assert.match(html, /aria-describedby=/);
  assert.match(html, /aria-label="Close dialog"/);
});
