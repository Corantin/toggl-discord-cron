const test = require("node:test");
const assert = require("node:assert/strict");
const { DateTime } = require("luxon");
const { backfillEndDate } = require("../backfill-end-date");

const endDate = (instant, scheduledRunHandlingYesterday = false) =>
  backfillEndDate(
    DateTime.fromISO(instant, { zone: "utc" }),
    "America/New_York",
    scheduledRunHandlingYesterday
  ).toISODate();

test("before the 10:00 UTC cron, leave yesterday for the scheduled run", () => {
  assert.equal(endDate("2026-11-22T09:59:59Z"), "2026-11-20");
  assert.equal(endDate("2026-07-10T09:59:59Z"), "2026-07-08");
});

test("after the cron time, include yesterday if no scheduled run handles it", () => {
  assert.equal(endDate("2026-11-22T10:00:00Z"), "2026-11-21");
  assert.equal(endDate("2026-07-10T10:00:00Z"), "2026-07-09");
});

test("after UTC midnight, use the New York report date's cron", () => {
  assert.equal(endDate("2026-11-22T01:00:00Z"), "2026-11-20");
  assert.equal(endDate("2026-07-11T01:00:00Z"), "2026-07-09");
});

test("a scheduled run already handling yesterday keeps it out of the backfill", () => {
  assert.equal(endDate("2026-11-22T12:00:00Z", true), "2026-11-20");
});
