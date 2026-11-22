// Keep this aligned with the cron expression in .github/workflows/toggl-discord.yml.
const DAILY_SCHEDULE_HOUR_UTC = 10;

function backfillEndDate(now, timeZone, scheduledRunHandlingYesterday = false) {
  const localToday = now.setZone(timeZone).startOf("day");
  const yesterday = localToday.minus({ days: 1 });
  const scheduledTimeToday = localToday
    .toUTC()
    .startOf("day")
    .plus({ hours: DAILY_SCHEDULE_HOUR_UTC });

  if (now.toUTC() < scheduledTimeToday || scheduledRunHandlingYesterday) {
    return yesterday.minus({ days: 1 });
  }

  return yesterday;
}

module.exports = { backfillEndDate };
