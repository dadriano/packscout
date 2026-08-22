import assert from "node:assert/strict";
import { test } from "node:test";
import {
  summarizeMigrationState,
  type MigrationHistoryRow,
} from "./migration-state.ts";

const REPOSITORY = ["20260812000000_baseline", "20260815010000_settlement"];

function attempt(
  name: string,
  overrides: Partial<MigrationHistoryRow> = {},
): MigrationHistoryRow {
  return {
    name,
    startedAt: "2026-08-18T00:00:00.000Z",
    finishedAt: "2026-08-18T00:00:01.000Z",
    rolledBackAt: null,
    ...overrides,
  };
}

test("a fresh database with no history reads as behind, not unknown", () => {
  const state = summarizeMigrationState(REPOSITORY, []);
  assert.equal(state.health, "behind");
  assert.equal(state.appliedCount, 0);
  assert.equal(state.repositoryCount, 2);
  assert.deepEqual([...state.pending], REPOSITORY);
  assert.deepEqual([...state.failed], []);
  assert.match(state.summary, /2 migrations pending/u);
});

test("every repository migration applied reads as current", () => {
  const state = summarizeMigrationState(REPOSITORY, REPOSITORY.map((name) => attempt(name)));
  assert.equal(state.health, "current");
  assert.equal(state.appliedCount, 2);
  assert.deepEqual([...state.pending], []);
  assert.match(state.summary, /current/u);
});

test("a rolled-back-then-reapplied migration aggregates to applied", () => {
  const state = summarizeMigrationState(REPOSITORY, [
    attempt(REPOSITORY[0]),
    attempt(REPOSITORY[1], {
      finishedAt: "2026-08-18T00:00:02.000Z",
      rolledBackAt: "2026-08-18T00:00:03.000Z",
    }),
    attempt(REPOSITORY[1], { finishedAt: "2026-08-18T00:10:00.000Z" }),
  ]);
  assert.equal(state.health, "current");
  assert.equal(state.appliedCount, 2);
  const reapplied = state.entries.find((entry) => entry.name === REPOSITORY[1]);
  assert.equal(reapplied?.outcome, "applied");
  assert.equal(reapplied?.attempts, 2);
});

test("a name whose only attempts failed reads as failed and outranks pending", () => {
  const state = summarizeMigrationState(REPOSITORY, [
    attempt(REPOSITORY[0], { finishedAt: null }),
  ]);
  assert.equal(state.health, "failed");
  assert.equal(state.appliedCount, 0);
  assert.deepEqual(
    state.failed.map((entry) => entry.name),
    [REPOSITORY[0]],
  );
  assert.deepEqual([...state.pending], [REPOSITORY[1]]);
  assert.match(state.failed[0]?.detail ?? "", /never finished/u);
});

test("a rolled-back migration that was never reapplied reads as failed", () => {
  const state = summarizeMigrationState([REPOSITORY[0]], [
    attempt(REPOSITORY[0], { rolledBackAt: "2026-08-18T00:00:05.000Z" }),
  ]);
  assert.equal(state.health, "failed");
  assert.match(state.failed[0]?.detail ?? "", /rolled back/u);
});

test("history the repository does not contain is reported as drift, not dropped", () => {
  const state = summarizeMigrationState(REPOSITORY, [
    ...REPOSITORY.map((name) => attempt(name)),
    attempt("20260814000000_hotfix_applied_by_hand"),
  ]);
  assert.equal(state.health, "drifted");
  assert.deepEqual([...state.unknownToRepository], ["20260814000000_hotfix_applied_by_hand"]);
  assert.equal(
    state.entries.find((entry) => entry.name === "20260814000000_hotfix_applied_by_hand")
      ?.inRepository,
    false,
  );
  assert.match(state.summary, /this repository does not contain/u);
});

test("a failure outranks drift so the urgent problem leads", () => {
  const state = summarizeMigrationState(REPOSITORY, [
    attempt(REPOSITORY[0]),
    attempt(REPOSITORY[1], { finishedAt: null }),
    attempt("20260814000000_hotfix_applied_by_hand"),
  ]);
  assert.equal(state.health, "failed");
  assert.equal(state.unknownToRepository.length, 1);
});

test("entries are ordered by name so the reading is stable across reads", () => {
  const state = summarizeMigrationState(
    [REPOSITORY[1], REPOSITORY[0]],
    [attempt(REPOSITORY[1])],
  );
  assert.deepEqual(
    state.entries.map((entry) => entry.name),
    REPOSITORY,
  );
});
