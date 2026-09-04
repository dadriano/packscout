import assert from "node:assert/strict";
import test from "node:test";
import {
  presentSaveControl,
  presentSavedItemMutationMessage,
} from "./saved-item-presentation";

const base = {
  kind: "repack" as const,
  saved: false,
  loading: false,
  pending: false,
};

test("a guest save action opens authentication without claiming a save", () => {
  const presentation = presentSaveControl({
    ...base,
    authStatus: "signed_out",
  });

  assert.equal(presentation.action, "login");
  assert.equal(presentation.disabled, false);
  assert.equal(presentation.pressed, false);
  assert.equal(presentation.label, "Sign in to save");
});

test("configured saved-item controls expose loading, pending, success, and error", () => {
  assert.deepEqual(
    presentSaveControl({ ...base, authStatus: "signed_in", loading: true }),
    {
      action: "none",
      disabled: true,
      label: "Checking saved items…",
      pressed: false,
      statusCopy: "Checking your saved items.",
      tone: "neutral",
    },
  );

  const saving = presentSaveControl({
    ...base,
    authStatus: "signed_in",
    saved: true,
    pending: true,
  });
  assert.equal(saving.label, "Saving…");
  assert.equal(saving.pressed, true);
  assert.equal(saving.disabled, true);

  const saved = presentSaveControl({
    ...base,
    authStatus: "signed_in",
    saved: true,
    message: { copy: "Repack saved to your account.", tone: "success" },
  });
  assert.equal(saved.action, "toggle");
  assert.equal(saved.label, "Saved repack");
  assert.equal(saved.tone, "success");

  const failed = presentSaveControl({
    ...base,
    authStatus: "signed_in",
    failed: true,
  });
  assert.equal(failed.action, "none");
  assert.equal(failed.disabled, true);
  assert.equal(failed.pressed, false);
  assert.equal(failed.label, "Save unavailable");
  assert.equal(failed.tone, "error");

  const writeFailed = presentSaveControl({
    ...base,
    authStatus: "signed_in",
    message: { copy: "Try again.", tone: "error" },
  });
  assert.equal(writeFailed.action, "toggle");
  assert.equal(writeFailed.statusCopy, "Try again.");
  assert.equal(writeFailed.tone, "error");
});

test("unconfigured and unverifiable sessions fail closed", () => {
  for (const authStatus of ["unavailable", "error"] as const) {
    const presentation = presentSaveControl({ ...base, authStatus });
    assert.equal(presentation.action, "none");
    assert.equal(presentation.disabled, true);
    assert.equal(presentation.pressed, false);
  }
});

test("an exact collectible has distinct saved-chase copy", () => {
  const presentation = presentSaveControl({
    ...base,
    authStatus: "signed_in",
    kind: "collectible",
    saved: true,
  });

  assert.equal(presentation.label, "Saved chase");
  assert.equal(presentation.pressed, true);
});

test("a capacity recovery is disclosed without exposing a retired public ID", () => {
  const message = presentSavedItemMutationMessage({
    kind: "collectible",
    saved: true,
    outcome: "success",
    prunedUnavailable: true,
  });

  assert.deepEqual(message, {
    copy: "Desired collectible saved to your account. An older unavailable save was removed to make room.",
    tone: "success",
  });
  assert.doesNotMatch(message.copy, /[0-9a-f]{8}-[0-9a-f-]{27,}/i);
});
