import assert from "node:assert/strict";
import { test } from "node:test";
import {
  droppedColumnIndex,
  presentColumnLayoutPersistence,
  presentColumnLayoutTrigger,
  presentColumnMoveAnnouncement,
  presentColumnVisibilityAnnouncement,
} from "./column-layout-presentation";

test("the columns trigger stays quiet until the layout differs from the default", () => {
  assert.deepEqual(
    presentColumnLayoutTrigger({
      total: 15,
      visibleCount: 15,
      hiddenCount: 0,
      reordered: false,
      customized: false,
    }),
    { label: "Columns", detail: null, customized: false, accessibleLabel: "Columns" },
  );
  assert.deepEqual(
    presentColumnLayoutTrigger({
      total: 15,
      visibleCount: 12,
      hiddenCount: 3,
      reordered: true,
      customized: true,
    }),
    {
      label: "Columns",
      detail: "3 hidden",
      customized: true,
      accessibleLabel: "Columns, 12 of 15 shown, custom order",
    },
  );
  assert.equal(
    presentColumnLayoutTrigger({
      total: 15,
      visibleCount: 15,
      hiddenCount: 0,
      reordered: true,
      customized: true,
    }).detail,
    null,
  );
});

test("persistence copy tells the viewer where the layout lives and offers sign-in only when it can happen", () => {
  assert.deepEqual(
    presentColumnLayoutPersistence({
      persistence: "session",
      authStatus: "signed_out",
      loading: false,
      saveState: "idle",
    }),
    {
      message: "Kept for this tab only.",
      tone: "neutral",
      action: "login",
      actionLabel: "Sign in to keep it",
    },
  );
  for (const authStatus of ["unavailable", "loading", "error", "signed_in"] as const) {
    assert.equal(
      presentColumnLayoutPersistence({
        persistence: "session",
        authStatus,
        loading: false,
        saveState: "idle",
      }).action,
      null,
    );
  }
  assert.equal(
    presentColumnLayoutPersistence({
      persistence: "account",
      authStatus: "signed_in",
      loading: true,
      saveState: "idle",
    }).message,
    "Loading your saved columns…",
  );
  assert.deepEqual(
    presentColumnLayoutPersistence({
      persistence: "account",
      authStatus: "signed_in",
      loading: false,
      saveState: "idle",
    }),
    { message: "Saved to your account.", tone: "positive", action: null, actionLabel: null },
  );
  assert.equal(
    presentColumnLayoutPersistence({
      persistence: "account",
      authStatus: "signed_in",
      loading: false,
      saveState: "saving",
    }).message,
    "Saving to your account…",
  );
  assert.equal(
    presentColumnLayoutPersistence({
      persistence: "account",
      authStatus: "signed_in",
      loading: false,
      saveState: "error",
    }).tone,
    "caution",
  );
});

test("announcements and drop targets describe the resulting position", () => {
  assert.equal(presentColumnMoveAnnouncement("EV %", 4, 15), "EV % moved to position 4 of 15.");
  assert.equal(presentColumnVisibilityAnnouncement("Heat", false), "Heat column hidden.");
  assert.equal(presentColumnVisibilityAnnouncement("Heat", true), "Heat column shown.");
  assert.equal(droppedColumnIndex({ fromIndex: 0, targetIndex: 3, before: true }), 2);
  assert.equal(droppedColumnIndex({ fromIndex: 0, targetIndex: 3, before: false }), 3);
  assert.equal(droppedColumnIndex({ fromIndex: 5, targetIndex: 1, before: true }), 1);
  assert.equal(droppedColumnIndex({ fromIndex: 5, targetIndex: 1, before: false }), 2);
  assert.equal(droppedColumnIndex({ fromIndex: 2, targetIndex: 2, before: true }), 2);
});
