import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatRelativeReleaseTime,
  presentDataReleaseStatus,
  recordUpdateRefreshIntervalMilliseconds,
} from "./data-release-status.client";

const NOW = Date.parse("2026-08-11T19:00:00.000Z");

test("data release status reports the active record-set update time", () => {
  const presentation = presentDataReleaseStatus(
    {
      state: "available",
      updatedAt: "2026-08-11T18:59:32.000Z",
      evaluatedAt: "2026-08-11T19:00:00.000Z",
      dataSource: "canonical",
    },
    NOW,
  );

  assert.equal(presentation.state, "available");
  assert.equal(presentation.visibleLabel, "Latest record update · 28s ago");
  assert.match(presentation.exactLabel, /^Latest catalog record update /);
  assert.equal(
    presentDataReleaseStatus({ state: "unavailable" }, NOW).visibleLabel,
    "Latest record update unavailable",
  );
  assert.equal(
    presentDataReleaseStatus({ state: "loading" }, NOW).visibleLabel,
    "Checking latest record update",
  );
});

test("data release status identifies mock records without presenting them as live", () => {
  const presentation = presentDataReleaseStatus(
    {
      state: "available",
      updatedAt: "2026-08-11T18:59:32.000Z",
      evaluatedAt: "2026-08-11T19:00:00.000Z",
      dataSource: "mock",
    },
    NOW,
  );

  assert.equal(presentation.visibleLabel, "Latest mock record update · 28s ago");
  assert.match(presentation.exactLabel, /^Latest mock catalog record update /);
});

test("available and transiently unavailable record status refresh once per minute", () => {
  assert.equal(
    recordUpdateRefreshIntervalMilliseconds({
      state: "available",
      updatedAt: "2026-08-11T18:59:00.000Z",
      evaluatedAt: "2026-08-11T19:00:00.000Z",
    }),
    60_000,
  );
  assert.equal(
    recordUpdateRefreshIntervalMilliseconds({ state: "unavailable" }),
    60_000,
  );
  assert.equal(
    recordUpdateRefreshIntervalMilliseconds({ state: "loading" }),
    null,
  );
});

test("release relative time is bounded and never reports future age", () => {
  assert.equal(formatRelativeReleaseTime("2026-08-11T19:00:10.000Z", NOW), "0s ago");
  assert.equal(formatRelativeReleaseTime("not-a-date", NOW), "recently");
  assert.equal(formatRelativeReleaseTime("2026-08-10T18:00:00.000Z", NOW), "1d ago");
  assert.equal(formatRelativeReleaseTime("2026-08-06T18:00:00.000Z", NOW), "5d ago");
});
