import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPackScoutEvClockStore,
  resolvePackScoutEvV3AtTime,
} from "./packscout-ev-clock.client";
import {
  FIXTURE_EXPIRES_AT,
  FIXTURE_OBSERVED_AT,
  buildV3CurrentEv,
  buildV3LastKnownEv,
  buildV3Price,
  buildV3SoldOutEv,
  buildV3UnavailableEv,
} from "./packscout-ev-fixtures.test-support";

const deadline = Date.parse(FIXTURE_EXPIRES_AT);
const price = buildV3Price();

test("crossing the old expiry keeps every EV value and its original times", () => {
  const current = buildV3CurrentEv(8_500);
  for (const now of [deadline - 1, deadline, deadline + 1, deadline + 24 * 60 * 60_000]) {
    const retained = resolvePackScoutEvV3AtTime(current, price, now);
    assert.equal(retained.status, "last_known");
    assert.deepEqual(retained.metrics, current.metrics);
    assert.equal(retained.calculatedAt, current.calculatedAt);
    assert.deepEqual(retained.dataAsOf, current.dataAsOf);
  }
});

test("confidence continues decaying to zero without disappearing or compounding", () => {
  const current = buildV3CurrentEv(8_500);
  const atTwoHours = deadline + 60 * 60_000;
  const first = resolvePackScoutEvV3AtTime(current, price, atTwoHours);
  const later = resolvePackScoutEvV3AtTime(first, price, deadline + 2 * 60 * 60_000);
  assert.equal(first.confidence?.scoreBasisPoints, 5_000);
  assert.equal(later.confidence?.scoreBasisPoints, 2_500);
  assert.deepEqual(resolvePackScoutEvV3AtTime(first, price, atTwoHours), first);
  const zero = resolvePackScoutEvV3AtTime(later, price, deadline + 24 * 60 * 60_000);
  assert.equal(zero.confidence?.scoreBasisPoints, 0);
  assert.equal(zero.confidence?.band, "low");
  assert.deepEqual(zero.metrics, current.metrics);
});

test("retained values keep their original price and failed-update reason", () => {
  const previous = buildV3LastKnownEv(8_500, { latestUnavailableReason: "BUYBACK_UNAVAILABLE" });
  const next = resolvePackScoutEvV3AtTime(previous, buildV3Price(20_000), deadline + 4 * 60 * 60_000);
  assert.equal(next.status, "last_known");
  if (next.status !== "last_known") assert.fail("expected retained EV");
  assert.equal(next.calculationPriceUsdMinor, 10_000);
  assert.equal(next.latestUnavailableReason, "BUYBACK_UNAVAILABLE");
  assert.equal(next.confidence.scoreBasisPoints, 0);
  assert.deepEqual(next.metrics, previous.metrics);
});

test("sold-out history keeps its sale time while confidence ages; absent values stay absent", () => {
  const soldOut = buildV3SoldOutEv(8_500);
  const historical = resolvePackScoutEvV3AtTime(soldOut, price, deadline + 60 * 60_000);
  assert.equal(historical.status, "last_known");
  if (historical.status !== "last_known") assert.fail("expected retained history");
  assert.equal(historical.historicalSoldOutAt, "2026-08-19T10:05:00.000Z");
  assert.equal(historical.confidence.scoreBasisPoints, 5_000);
  const unavailable = buildV3UnavailableEv();
  assert.equal(resolvePackScoutEvV3AtTime(unavailable, price, deadline + 60_000), unavailable);
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


test("an open page updates confidence every minute without changing the server snapshot", (t) => {
  const startedAt = Date.parse(FIXTURE_OBSERVED_AT);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: startedAt });
  const page = stubOpenPage();
  t.after(() => page.restore());
  const store = createPackScoutEvClockStore(startedAt);
  assert.equal(store.getServerSnapshot(), startedAt);
  assert.equal(store.getSnapshot(), startedAt);
  let notifications = 0;
  const unsubscribe = store.subscribe(() => { notifications += 1; });
  const mountedNotifications = notifications;
  t.mock.timers.tick(60_100);
  assert.ok(notifications > mountedNotifications);
  assert.equal(store.getSnapshot(), startedAt + 60_000);
  const minuteNotifications = notifications;
  t.mock.timers.tick(60_000);
  assert.ok(notifications > minuteNotifications);
  assert.equal(store.getSnapshot(), startedAt + 120_000);
  assert.equal(store.getServerSnapshot(), startedAt);
  unsubscribe();
  const stoppedNotifications = notifications;
  t.mock.timers.tick(60_000);
  assert.equal(notifications, stoppedNotifications);
});

test("clock snapshots never regress behind the served confidence clock", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: deadline - 60_000 });
  const store = createPackScoutEvClockStore(deadline);
  assert.equal(store.getSnapshot(), deadline);
});

test("a browser clock rollback cannot increase confidence after it has aged", (t) => {
  const reference = Date.parse(FIXTURE_OBSERVED_AT);
  const forward = deadline + 90 * 60_000;
  t.mock.timers.enable({ apis: ["Date"], now: forward });
  const store = createPackScoutEvClockStore(reference);
  const current = buildV3CurrentEv(8_500);
  const aged = resolvePackScoutEvV3AtTime(current, price, store.getSnapshot()!);
  assert.equal(store.getSnapshot(), forward);
  t.mock.timers.setTime(deadline + 30 * 60_000);
  assert.equal(store.getSnapshot(), forward);
  assert.equal(store.getServerSnapshot(), reference);
  assert.deepEqual(resolvePackScoutEvV3AtTime(current, price, store.getSnapshot()!), aged);
});

test("a pack without previous values schedules no confidence timer", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: deadline });
  const page = stubOpenPage();
  t.after(() => page.restore());
  const store = createPackScoutEvClockStore(null);
  let notifications = 0;
  const unsubscribe = store.subscribe(() => { notifications += 1; });
  t.mock.timers.tick(10 * 60_000);
  assert.equal(notifications, 0);
  assert.equal(store.getSnapshot(), null);
  assert.equal(store.getServerSnapshot(), null);
  unsubscribe();
});
