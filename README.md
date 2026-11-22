# Toggl → Discord cron

Posts a Toggl summary (current timer, today, and this week grouped by project) into a Discord channel via webhook. Runs on a daily scheduled GitHub Action or on demand.

## Setup
- Create a Discord webhook (Channel Settings → Integrations → Webhooks) and copy the URL.
- Find your Toggl API token (Toggl Profile → API Token).
- Optional: note the workspace ID if you want project names instead of IDs.

### Repository secrets
Add these secrets in the repository settings for Actions:
- `TOGGL_TOKEN` – your Toggl API token.
- `DISCORD_WEBHOOK` – the Discord webhook URL.
- `TOGGL_WORKSPACE_ID` – optional; workspace id to resolve project names.
- `DISCORD_THREAD_ID` – optional; thread id if you want the webhook to post inside a specific thread.
- `TOGGL_PROJECT_ID` – optional; restricts reporting to a single project id (e.g., `203141064`).
- `DRY_RUN` – optional; set to `true` to log the message instead of posting to Discord.
- `RUN_DATE` – optional date in `YYYY-MM-DD` (e.g., `2025-12-05`) or `today`/`yesterday` to control which day is reported.
- `BACKFILL_FROM_DATE` – optional date in `YYYY-MM-DD` (e.g., `2025-12-01`) to post each day from that date through the last day not reserved for the daily schedule.

## Running locally
```bash
# Or set them in a .env file (TOGGL_TOKEN, DISCORD_WEBHOOK, etc.)
pnpm install
TOGGL_TOKEN=xxx DISCORD_WEBHOOK=xxx TOGGL_WORKSPACE_ID=123 TOGGL_PROJECT_ID=203141064 DRY_RUN=true pnpm start
```

## Schedule
The workflow at `.github/workflows/toggl-discord.yml` runs daily at 10:00 UTC and can also be triggered manually (`workflow_dispatch`). Update the cron as needed.

The separate `.github/workflows/keep-schedules-active.yml` workflow checks the latest commit on `main` daily at 02:37 UTC. After 45 days without a commit, it pushes an empty commit using the repository's `GITHUB_TOKEN`, ahead of GitHub's 60-day inactivity cutoff for scheduled workflows in public repositories. It can also be triggered manually. GitHub must allow Actions to write to `main`; the keepalive run will fail visibly if the push is blocked. A disabled scheduled workflow must be enabled once before its schedule can run again.

## Notes
- Each message summarizes a single day’s entries; no weekly totals are posted.
- The script ignores time entries before 2025-12-04 to avoid processing older Toggl data.
- When `TOGGL_PROJECT_ID` is set, only that project’s entries are included in the report.
- If there are no entries for a day, that day is skipped without posting to Discord.
- Labels/tags on entries are included; entries with multiple tags appear once under a combined label. Durations use the exact tracked time, with a single total for the day.
- Set `DRY_RUN=true` to print the would-be Discord message and skip posting.
- Day boundary uses America/New_York (EST/EDT); “today” is evaluated in that timezone before querying Toggl, and entries are attributed to the day they start (so cross-midnight entries stay on their start date).
- The workflow_dispatch input `run_date` defaults to `yesterday`; provide a date in `YYYY-MM-DD` or `today`/`yesterday` to report a different day.
- The workflow_dispatch input `backfill_from_date` posts one summary per day from the provided `YYYY-MM-DD` date through the last day not reserved for the daily schedule, and takes precedence over `run_date`. Before the 10:00 UTC cron time on the current New York date, backfills stop at the day before yesterday so the upcoming scheduled run can post yesterday. After 10:00 UTC, they may include yesterday if no scheduled run for that date succeeded. If that run is still pending, the backfill fails so it can be retried after the scheduled run finishes. GitHub can delay scheduled runs, so this check uses the run history available when the backfill starts.
- For a manual catch-up, check `backfill_since_last_successful_run`. The workflow finds the newest successful scheduled run, full backfill, or manual `yesterday` report and starts after the last day it covered. A backfill completed before the 10:00 UTC cron is recognized as ending one day earlier. It uses the same backfill end-date rule and ignores `run_date`. Single-day manual runs with a custom `run_date` are not used as a checkpoint. Leave `backfill_from_date` blank when using this option. If no successful run exists, enter a start date manually. A successful run may have skipped posting when there were no entries or when `DRY_RUN` was enabled.
