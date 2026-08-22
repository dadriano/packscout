import assert from "node:assert/strict";
import { test } from "node:test";
import { extractLineTimestamp, MAX_BACKDATE_MS } from "./line-timestamp.ts";

const ARRIVAL = "2026-08-20T10:00:00.000Z";

/** Zone-less formats are read in local time; build the expectation the same way. */
function localIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms = 0,
): string {
  return new Date(year, month - 1, day, hour, minute, second, ms).toISOString();
}

test("an ISO stamp with a zone is used exactly", () => {
  const time = extractLineTimestamp(
    "2026-08-20T09:59:12.500Z [worker] import started",
    ARRIVAL,
  );
  assert.deepEqual(time, {
    at: "2026-08-20T09:59:12.500Z",
    approximate: false,
    source: "line",
  });
});

test("an offset zone is honoured rather than assumed to be UTC", () => {
  const time = extractLineTimestamp("2026-08-20T11:59:12+02:00 ready", ARRIVAL);
  assert.equal(time.at, "2026-08-20T09:59:12.000Z");
  assert.equal(time.source, "line");
});

test("a zone-less date and time is read as local time", () => {
  const arrival = localIso(2026, 8, 20, 10, 0, 0);
  const time = extractLineTimestamp("2026-08-20 09:58:01,250 warn slow", arrival);
  assert.equal(time.at, localIso(2026, 8, 20, 9, 58, 1, 250));
  assert.equal(time.approximate, false);
});

test("a bare clock borrows the date from arrival", () => {
  const arrival = localIso(2026, 8, 20, 10, 0, 0);
  const time = extractLineTimestamp("[09:45:30] GET /api/packs 200", arrival);
  assert.equal(time.at, localIso(2026, 8, 20, 9, 45, 30));
  assert.equal(time.source, "line");
});

test("a clock from just before midnight belongs to yesterday, not tomorrow", () => {
  const arrival = localIso(2026, 8, 20, 0, 1, 0);
  const time = extractLineTimestamp("23:59:12 flushing", arrival);
  assert.equal(time.at, localIso(2026, 8, 19, 23, 59, 12));
});

test("a syslog stamp takes its year from arrival", () => {
  const arrival = localIso(2026, 8, 20, 10, 0, 0);
  const time = extractLineTimestamp("Aug 20 09:12:00 packscout worker[1]: ok", arrival);
  assert.equal(time.at, localIso(2026, 8, 20, 9, 12, 0));
});

test("an implausible instant is refused in favour of arrival", () => {
  const future = extractLineTimestamp("2031-01-01T00:00:00Z scheduled", ARRIVAL);
  assert.deepEqual(future, { at: ARRIVAL, approximate: true, source: "arrival" });

  const ancient = new Date(Date.parse(ARRIVAL) - MAX_BACKDATE_MS - 86_400_000)
    .toISOString()
    .replace(/\.\d{3}Z$/u, ".000Z");
  const old = extractLineTimestamp(`${ancient} replayed`, ARRIVAL);
  assert.equal(old.source, "arrival");
  assert.equal(old.approximate, true);
});

test("a time-shaped run later in the line is not mistaken for a stamp", () => {
  const time = extractLineTimestamp(
    "import finished after a wall time of 01:02:03 across four providers and a very long tail",
    ARRIVAL,
  );
  assert.equal(time.source, "arrival");
});

test("a line with no usable stamp falls back to arrival, marked approximate", () => {
  const time = extractLineTimestamp("just some output", ARRIVAL);
  assert.deepEqual(time, { at: ARRIVAL, approximate: true, source: "arrival" });
});

test("an unusable arrival time still yields a value rather than throwing", () => {
  const time = extractLineTimestamp("2026-08-20T09:00:00Z ok", "not a date");
  assert.deepEqual(time, { at: "not a date", approximate: true, source: "arrival" });
});

test("an impossible clock is rejected instead of being wrapped around", () => {
  const time = extractLineTimestamp("99:99:99 nonsense", ARRIVAL);
  assert.equal(time.source, "arrival");
});
