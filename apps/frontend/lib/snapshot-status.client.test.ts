import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatRelativeSnapshotTime,
  presentSnapshotStatus,
} from "./snapshot-status.client";

const NOW = Date.parse("2026-08-11T19:00:00.000Z");

test("snapshot status exposes stable fresh, delayed, loading, and unavailable copy", () => {
  assert.equal(
    presentSnapshotStatus(
      {
        state: "fresh",
        updatedAt: "2026-08-11T18:59:32.000Z",
        dataSource: "canonical",
      },
      NOW,
    ).visibleLabel,
    "Updated 28s ago",
  );
  assert.equal(
    presentSnapshotStatus(
      {
        state: "delayed",
        updatedAt: "2026-08-11T18:38:00.000Z",
        dataSource: "canonical",
      },
      NOW,
    ).visibleLabel,
    "Some data delayed · Updated 22m ago",
  );
  assert.equal(
    presentSnapshotStatus({ state: "unavailable" }, NOW).visibleLabel,
    "Pack data unavailable",
  );
  assert.equal(
    presentSnapshotStatus({ state: "loading" }, NOW).visibleLabel,
    "Checking catalog status",
  );
});

test("snapshot status identifies mock data without presenting it as live", () => {
  const fresh = presentSnapshotStatus(
    {
      state: "fresh",
      updatedAt: "2026-08-11T18:59:32.000Z",
      dataSource: "mock",
    },
    NOW,
  );
  assert.equal(fresh.visibleLabel, "Mock data · Updated 28s ago");
  assert.match(fresh.exactLabel, /^Mock catalog data updated /);

  const delayed = presentSnapshotStatus(
    {
      state: "delayed",
      updatedAt: "2026-08-11T18:38:00.000Z",
      dataSource: "mock",
    },
    NOW,
  );
  assert.equal(delayed.visibleLabel, "Mock data delayed · 22m ago");
  assert.match(delayed.exactLabel, /^Mock catalog data is delayed\./);
});

test("snapshot relative time is bounded and never reports future age", () => {
  assert.equal(formatRelativeSnapshotTime("2026-08-11T19:00:10.000Z", NOW), "0s ago");
  assert.equal(formatRelativeSnapshotTime("not-a-date", NOW), "recently");
  assert.equal(formatRelativeSnapshotTime("2026-08-10T18:00:00.000Z", NOW), "1d ago");
});
