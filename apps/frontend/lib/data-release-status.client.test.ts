import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatRelativeReleaseTime,
  presentDataReleaseStatus,
} from "./data-release-status.client";

const NOW = Date.parse("2026-08-11T19:00:00.000Z");

test("data release status exposes stable fresh, delayed, loading, and unavailable copy", () => {
  assert.equal(
    presentDataReleaseStatus(
      {
        state: "fresh",
        updatedAt: "2026-08-11T18:59:32.000Z",
        staleAt: "2026-08-11T19:15:00.000Z",
        dataSource: "canonical",
      },
      NOW,
    ).visibleLabel,
    "Updated 28s ago",
  );
  assert.equal(
    presentDataReleaseStatus(
      {
        state: "delayed",
        updatedAt: "2026-08-11T18:38:00.000Z",
        staleAt: "2026-08-11T18:53:00.000Z",
        dataSource: "canonical",
      },
      NOW,
    ).visibleLabel,
    "Some data delayed · Updated 22m ago",
  );
  assert.equal(
    presentDataReleaseStatus({ state: "unavailable" }, NOW).visibleLabel,
    "Repack data unavailable",
  );
  assert.equal(
    presentDataReleaseStatus({ state: "loading" }, NOW).visibleLabel,
    "Checking repack data",
  );
});

test("data release status identifies mock data without presenting it as live", () => {
  const fresh = presentDataReleaseStatus(
    {
      state: "fresh",
      updatedAt: "2026-08-11T18:59:32.000Z",
      staleAt: "2026-08-11T19:15:00.000Z",
      dataSource: "mock",
    },
    NOW,
  );
  assert.equal(fresh.visibleLabel, "Mock data · Updated 28s ago");
  assert.match(fresh.exactLabel, /^Mock repack data updated /);

  const delayed = presentDataReleaseStatus(
    {
      state: "delayed",
      updatedAt: "2026-08-11T18:38:00.000Z",
      staleAt: "2026-08-11T18:53:00.000Z",
      dataSource: "mock",
    },
    NOW,
  );
  assert.equal(delayed.visibleLabel, "Mock data delayed · 22m ago");
  assert.match(delayed.exactLabel, /^Mock repack data is delayed\./);
});

test("freshness becomes delayed when the published stale deadline passes", () => {
  const presentation = presentDataReleaseStatus(
    {
      state: "fresh",
      updatedAt: "2026-08-11T18:38:00.000Z",
      staleAt: "2026-08-11T18:53:00.000Z",
      dataSource: "canonical",
    },
    NOW,
  );
  assert.equal(presentation.state, "delayed");
  assert.equal(presentation.visibleLabel, "Some data delayed · Updated 22m ago");
});

test("release relative time is bounded and never reports future age", () => {
  assert.equal(formatRelativeReleaseTime("2026-08-11T19:00:10.000Z", NOW), "0s ago");
  assert.equal(formatRelativeReleaseTime("not-a-date", NOW), "recently");
  assert.equal(formatRelativeReleaseTime("2026-08-10T18:00:00.000Z", NOW), "1d ago");
});
