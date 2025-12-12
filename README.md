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

## Running locally
```bash
# Or set them in a .env file (TOGGL_TOKEN, DISCORD_WEBHOOK, etc.)
pnpm install
TOGGL_TOKEN=xxx DISCORD_WEBHOOK=xxx TOGGL_WORKSPACE_ID=123 TOGGL_PROJECT_ID=203141064 DRY_RUN=true pnpm start
```

## Schedule
The workflow at `.github/workflows/toggl-discord.yml` runs daily at 08:00 UTC and can also be triggered manually (`workflow_dispatch`). Update the cron as needed.

## Notes
- Only today’s entries are summarized; no weekly totals are posted.
- The script ignores time entries before 2025-12-04 to avoid processing older Toggl data.
- When `TOGGL_PROJECT_ID` is set, only that project’s entries are included in the report.
- If there are no entries today, the workflow exits without posting to Discord.
- Labels/tags on entries are included; the message lists entries grouped under each label with per-label totals.
- Set `DRY_RUN=true` to print the would-be Discord message and skip posting.
- Day boundary uses America/New_York (EST/EDT); “today” is evaluated in that timezone before querying Toggl.
