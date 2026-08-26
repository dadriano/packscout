import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OperatorDialog } from "./OperatorDialog.tsx";

function render(mode: "invite" | "create"): string {
  Object.assign(globalThis, { React });
  return renderToStaticMarkup(
    <OperatorDialog
      open
      mode={mode}
      pending={false}
      error={null}
      onClose={() => undefined}
      onSubmit={async () => undefined}
    />,
  );
}

test("direct creation collects an initial password with secure handoff copy", () => {
  const html = render("create");

  assert.match(html, /Create an operator with a password/);
  assert.match(html, /label for="operator-display-name">Display name/);
  assert.match(html, /label for="operator-email">Email/);
  assert.match(html, /label for="operator-role">Role/);
  assert.match(html, /label for="operator-password">Initial password/);
  assert.match(html, /type="password"/);
  assert.match(html, /minLength="12"/);
  assert.match(html, /maxLength="128"/);
  assert.match(html, /separate secure channel/);
  assert.match(html, /never included in the email/);
});

test("invitation remains password-free and keeps its original action", () => {
  const html = render("invite");

  assert.match(html, /Invite an operator/);
  assert.match(html, /Send invitation/);
  assert.match(html, /No password is set here/);
  assert.doesNotMatch(html, /id="operator-password"/);
  assert.doesNotMatch(html, /Initial password/);
});
