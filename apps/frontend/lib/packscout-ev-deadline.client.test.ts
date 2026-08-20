import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPackScoutEvDeadlineStore,
  expireCurrentPackScoutEvV3,
  packScoutEvDeadlineMillis,
  resolvePackScoutEvV3AtTime,
} from "./packscout-ev-deadline.client";
import {
  FIXTURE_EXPIRES_AT,
  FIXTURE_OBSERVED_AT,
  buildV3CurrentEv,
  buildV3SoldOutEv,
  buildV3UnavailableEv,
} from "./packscout-ev-fixtures.test-support";

const deadline = Date.parse(FIXTURE_EXPIRES_AT);

test("a current estimate stays presentable through its exact deadline", () => {
  const current = buildV3CurrentEv(8_500);

  assert.equal(packScoutEvDeadlineMillis(current), deadline);
  assert.equal(resolvePackScoutEvV3AtTime(current, deadline - 1), current);
  // Contract semantics: presentable while now <= expiresAt.
  assert.equal(resolvePackScoutEvV3AtTime(current, deadline), current);
});

test("strictly after the deadline the estimate converts to the stale state", () => {
  const current = buildV3CurrentEv(8_500);
  const now = deadline + 1;
  const expired = resolvePackScoutEvV3AtTime(current, now);

  assert.notEqual(expired, current);
  assert.deepEqual(expired, {
    status: "unavailable",
    methodVersion: current.methodVersion,
    confidencePolicyVersion: current.confidencePolicyVersion,
    metrics: null,
    confidence: null,
    calculatedAt: new Date(now).toISOString(),
    dataAsOf: { state: "known", observedAt: FIXTURE_OBSERVED_AT },
    reason: "SOURCE_DATA_STALE",
  });
});

test("conversion mirrors the server: metrics vanish and never become zero", () => {
  const expired = expireCurrentPackScoutEvV3(
    buildV3CurrentEv(8_500),
    deadline + 60_000,
  );

  assert.equal(expired.status, "unavailable");
  assert.equal(expired.metrics, null);
  assert.equal(expired.confidence, null);
  assert.doesNotMatch(JSON.stringify(expired), /"minorUnits":0/);
});

test("historical and unavailable estimates never expire into a live state", () => {
  const soldOut = buildV3SoldOutEv(8_500);
  const unavailable = buildV3UnavailableEv("BUYBACK_UNAVAILABLE");

  assert.equal(packScoutEvDeadlineMillis(soldOut), null);
  assert.equal(packScoutEvDeadlineMillis(unavailable), null);
  assert.equal(
    resolvePackScoutEvV3AtTime(soldOut, Number.MAX_SAFE_INTEGER),
    soldOut,
  );
  assert.equal(
    resolvePackScoutEvV3AtTime(unavailable, Number.MAX_SAFE_INTEGER),
    unavailable,
  );
  assert.equal(expireCurrentPackScoutEvV3(unavailable, deadline), unavailable);
});

type BrowserStub = Readonly<{ restore: () => void }>;

function stubOpenPage(): BrowserStub {
  const previousWindow = Reflect.get(globalThis, "window");
  const previousDocument = Reflect.get(globalThis, "document");
  Reflect.set(globalThis, "window", {
    setTimeout: (handler: () => void, delay?: number) =>
      setTimeout(handler, delay) as unknown as number,
    clearTimeout: (timer: number) =>
      clearTimeout(timer as unknown as NodeJS.Timeout),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  Reflect.set(globalThis, "document", {
    visibilityState: "visible",
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  return {
    restore: () => {
      if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window");
      else Reflect.set(globalThis, "window", previousWindow);
      if (previousDocument === undefined) {
        Reflect.deleteProperty(globalThis, "document");
      } else Reflect.set(globalThis, "document", previousDocument);
    },
  };
}

test("an already-open page converts at the deadline without a reload", (t) => {
  const startedAt = deadline - 90_000;
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: startedAt });
  const page = stubOpenPage();
  t.after(() => page.restore());

  const store = createPackScoutEvDeadlineStore(deadline);
  // Hydration safety: the server snapshot never disagrees with the server
  // render, and at mount time the client snapshot agrees with it.
  assert.equal(store.getServerSnapshot(), false);
  assert.equal(store.getSnapshot(), false);

  let notifications = 0;
  const unsubscribe = store.subscribe(() => {
    notifications += 1;
  });

  // Passive clock ticks before the deadline announce and change nothing.
  t.mock.timers.tick(89_000);
  assert.equal(notifications, 0);
  assert.equal(store.getSnapshot(), false);

  // The scheduled wake-up strictly after the deadline flips the snapshot once.
  t.mock.timers.tick(2_000);
  assert.equal(notifications, 1);
  assert.equal(store.getSnapshot(), true);
  assert.equal(store.getServerSnapshot(), false);

  unsubscribe();
});

test("a store without a deadline never schedules or notifies", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: deadline });
  const page = stubOpenPage();
  t.after(() => page.restore());

  const store = createPackScoutEvDeadlineStore(null);
  let notifications = 0;
  const unsubscribe = store.subscribe(() => {
    notifications += 1;
  });
  t.mock.timers.tick(10 * 60_000);
  assert.equal(notifications, 0);
  assert.equal(store.getSnapshot(), false);
  unsubscribe();
});
