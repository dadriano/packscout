import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createStreamBudget,
  DEFAULT_STREAM_BUDGET,
  type StreamLease,
} from "./stream-budget.ts";

test("the default budget stays under the browser's per-origin connection cap", () => {
  assert.ok(DEFAULT_STREAM_BUDGET >= 1 && DEFAULT_STREAM_BUDGET <= 4);
});

test("a budget grants up to its limit immediately", () => {
  const budget = createStreamBudget(2);
  const granted: string[] = [];
  budget.request("logs", (lease) => granted.push(lease.name));
  budget.request("database", (lease) => granted.push(lease.name));
  assert.deepEqual(granted, ["logs", "database"]);
  assert.equal(budget.activeCount(), 2);
  assert.equal(budget.queuedCount(), 0);
});

test("requests beyond the limit wait instead of opening a connection", () => {
  const budget = createStreamBudget(1);
  const leases: StreamLease[] = [];
  budget.request("logs", (lease) => leases.push(lease));
  budget.request("activity", (lease) => leases.push(lease));

  assert.deepEqual(
    leases.map((lease) => lease.name),
    ["logs"],
  );
  assert.equal(budget.queuedCount(), 1);

  leases[0]?.release();
  assert.deepEqual(
    leases.map((lease) => lease.name),
    ["logs", "activity"],
  );
  assert.equal(budget.activeCount(), 1);
  assert.equal(budget.queuedCount(), 0);
});

test("waiting requests are granted in order", () => {
  const budget = createStreamBudget(1);
  const order: string[] = [];
  const first = { lease: undefined as StreamLease | undefined };
  budget.request("first", (lease) => {
    order.push("first");
    first.lease = lease;
  });
  budget.request("second", () => order.push("second"));
  budget.request("third", () => order.push("third"));

  first.lease?.release();
  assert.deepEqual(order, ["first", "second"]);
});

test("cancelling a queued request never opens a stream", () => {
  const budget = createStreamBudget(1);
  const order: string[] = [];
  let held: StreamLease | undefined;
  budget.request("held", (lease) => {
    held = lease;
  });
  const cancel = budget.request("cancelled", () => order.push("cancelled"));
  cancel();
  assert.equal(budget.queuedCount(), 0);

  held?.release();
  assert.deepEqual(order, []);
  assert.equal(budget.activeCount(), 0);
});

test("cancelling a granted request releases its slot once", () => {
  const budget = createStreamBudget(1);
  let lease: StreamLease | undefined;
  const cancel = budget.request("logs", (granted) => {
    lease = granted;
  });
  cancel();
  cancel();
  lease?.release();
  assert.equal(budget.activeCount(), 0);
  assert.equal(lease?.isActive(), false);
});

test("an invalid limit is refused", () => {
  assert.throws(() => createStreamBudget(0), /positive integer/);
  assert.throws(() => createStreamBudget(1.5), /positive integer/);
});
