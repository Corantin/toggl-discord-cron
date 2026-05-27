#!/usr/bin/env node

require("dotenv").config();
const { DateTime } = require("luxon");

const TOGGL_TOKEN = process.env.TOGGL_TOKEN;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const TOGGL_WORKSPACE_ID = process.env.TOGGL_WORKSPACE_ID;
const DISCORD_THREAD_ID = process.env.DISCORD_THREAD_ID;
const TIMEZONE = "America/New_York"; // EST/EDT
const MIN_ENTRY_DATE = DateTime.fromISO("2025-12-04T00:00:00Z").toUTC(); // ignore entries before this date
const TOGGL_PROJECT_ID = process.env.TOGGL_PROJECT_ID
  ? Number(process.env.TOGGL_PROJECT_ID)
  : undefined;
const RUN_DATE = process.env.RUN_DATE; // optional YYYY-MM-DD date, "today", or "yesterday" for current day in TZ
const BACKFILL_FROM_DATE = process.env.BACKFILL_FROM_DATE; // optional YYYY-MM-DD date to backfill through yesterday in TZ
const DRY_RUN =
  process.env.DRY_RUN === "1" ||
  process.env.DRY_RUN === "true" ||
  process.env.DRY_RUN === "yes";

if (!TOGGL_TOKEN) {
  console.error("Missing TOGGL_TOKEN environment variable");
  process.exit(1);
}

if (!DISCORD_WEBHOOK) {
  console.error("Missing DISCORD_WEBHOOK environment variable");
  process.exit(1);
}

if (process.env.TOGGL_PROJECT_ID && Number.isNaN(TOGGL_PROJECT_ID)) {
  console.error(
    "Invalid TOGGL_PROJECT_ID environment variable; must be a number"
  );
  process.exit(1);
}

const API_BASE = "https://api.track.toggl.com/api/v9";
const REPORTS_API_BASE = "https://api.track.toggl.com/reports/api/v3";
const authHeader = `Basic ${Buffer.from(`${TOGGL_TOKEN}:api_token`).toString(
  "base64"
)}`;

/**
 * @typedef {Error & {status?: number, statusText?: string, body?: string}} RequestError
 */

/**
 * @param {number} status
 * @param {string} statusText
 * @param {string} errorText
 * @returns {RequestError}
 */
function buildRequestError(status, statusText, errorText) {
  return Object.assign(
    new Error(`Request failed ${status} ${statusText}: ${errorText}`),
    {
      status,
      statusText,
      body: errorText,
    }
  );
}

/**
 * @param {string} responseText
 */
function parseJsonResponse(responseText) {
  if (!responseText) return null;

  try {
    return JSON.parse(responseText);
  } catch {
    return responseText;
  }
}

/**
 * @param {unknown} error
 */
function isRateLimitError(error) {
  if (!error) return false;
  const requestError = /** @type {RequestError | undefined} */ (
    typeof error === "object" ? error : undefined
  );

  if (requestError?.status === 429) return true;

  const message = `${requestError?.message || ""} ${requestError?.body || ""}`;
  return /rate limit/i.test(message);
}

/**
 * @param {string} url
 * @param {RequestInit & {headers?: Record<string, string>}} [options={}]
 */
async function fetchJson(url, options = {}) {
  const headers = /** @type {Record<string, string>} */ ({
    Authorization: authHeader,
    ...(options.headers || {}),
  });

  if (options.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url, { ...options, headers });
  const responseText = await response
    .text()
    .catch(() => "<unable to read response>");

  if (!response.ok) {
    throw buildRequestError(
      response.status,
      response.statusText,
      responseText
    );
  }

  if (response.status === 204) return null;
  return parseJsonResponse(responseText);
}

/**
 * @param {DateTime} start
 * @param {DateTime} end
 */
async function getTimeEntries(start, end) {
  const clampedStartMillis = Math.max(
    start.toMillis(),
    MIN_ENTRY_DATE.toMillis()
  );
  const clampedStart = DateTime.fromMillis(clampedStartMillis).toUTC();
  const endUtc = end.toUTC();

  if (clampedStart >= endUtc) {
    return [];
  }
  const startIso = clampedStart.toISO();
  const endIso = endUtc.toISO();

  if (!startIso || !endIso) {
    throw new Error("Unable to format Toggl request date range");
  }

  const url = `${API_BASE}/me/time_entries?start_date=${encodeURIComponent(
    startIso
  )}&end_date=${encodeURIComponent(endIso)}`;

  try {
    return fetchJson(url);
  } catch (error) {
    if (!isRateLimitError(error)) {
      throw error;
    }

    console.warn(
      "Toggl /me/time_entries was rate-limited; retrying via workspace reports endpoint."
    );
    return getWorkspaceReportEntries(clampedStart, endUtc);
  }
}

/**
 * @param {DateTime} start
 * @param {DateTime} end
 */
async function getWorkspaceReportEntries(start, end) {
  if (!TOGGL_WORKSPACE_ID) {
    throw new Error(
      "Toggl /me/time_entries was rate-limited, but TOGGL_WORKSPACE_ID is not configured for workspace reports fallback"
    );
  }

  const endExclusiveLocal = end.setZone(TIMEZONE);
  const endInclusiveLocal = endExclusiveLocal.minus({ milliseconds: 1 });
  const requestBody = {
    start_date: start.setZone(TIMEZONE).toFormat("yyyy-LL-dd"),
    end_date: endInclusiveLocal.toFormat("yyyy-LL-dd"),
    startTime: start.toISO(),
    endTime: end.toISO(),
    grouped: false,
    enrich_response: true,
    order_by: "date",
    order_dir: "ASC",
    page_size: 10000,
    project_ids: TOGGL_PROJECT_ID ? [TOGGL_PROJECT_ID] : undefined,
  };

  const url = `${REPORTS_API_BASE}/workspace/${encodeURIComponent(
    TOGGL_WORKSPACE_ID
  )}/search/time_entries`;
  const response = await fetchJson(url, {
    method: "POST",
    body: JSON.stringify(requestBody),
  });

  return normalizeReportEntries(response);
}

/**
 * @param {any[]} entries
 */
function normalizeReportEntries(entries) {
  if (!Array.isArray(entries)) return [];

  return entries.flatMap((entryGroup) => {
    if (Array.isArray(entryGroup?.time_entries)) {
      return entryGroup.time_entries.map((timeEntry) => ({
        ...timeEntry,
        description: entryGroup.description || timeEntry.description,
        duration:
          typeof timeEntry.seconds === "number"
            ? timeEntry.seconds
            : timeEntry.duration,
        project_id: entryGroup.project_id ?? timeEntry.project_id,
        tags: Array.isArray(entryGroup.tag_names) ? entryGroup.tag_names : [],
        task_id: entryGroup.task_id ?? timeEntry.task_id,
      }));
    }

    return {
      ...entryGroup,
      duration:
        typeof entryGroup.seconds === "number"
          ? entryGroup.seconds
          : entryGroup.duration,
      tags: Array.isArray(entryGroup.tags)
        ? entryGroup.tags
        : Array.isArray(entryGroup.tag_names)
          ? entryGroup.tag_names
          : [],
    };
  });
}

function entryDurationSeconds(entry) {
  if (!entry) return 0;
  if (typeof entry.duration === "number" && entry.duration >= 0)
    return entry.duration;

  const start = entry.start ? new Date(entry.start).getTime() : 0;
  if (!start) return 0;

  return Math.max(0, Math.floor((Date.now() - start) / 1000));
}

function roundToNearestFiveMinutes(seconds) {
  // Enforce 5-minute minimum for any positive duration
  if (seconds <= 0) return 0;
  return Math.max(300, Math.round(seconds / 300) * 300);
}

function formatDuration(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h${minutes.toString().padStart(2, "0")}`;
  if (minutes > 0) return `${minutes}m${seconds.toString().padStart(2, "0")}`;
  return `${seconds}s`;
}

function summarizeByTag(entries) {
  const totals = new Map();

  for (const entry of entries || []) {
    const seconds = roundToNearestFiveMinutes(entryDurationSeconds(entry));
    const tags = Array.isArray(entry.tags) ? entry.tags : [];
    if (!tags.length) {
      if (!totals.has("(no label)")) totals.set("(no label)", 0);
      totals.set("(no label)", totals.get("(no label)") + seconds);
      continue;
    }
    for (const tag of tags) {
      if (!totals.has(tag)) totals.set(tag, 0);
      totals.set(tag, totals.get(tag) + seconds);
    }
  }

  return Array.from(totals.entries())
    .map(([name, seconds]) => ({ name, seconds }))
    .sort((a, b) => b.seconds - a.seconds);
}

function totalRoundedSeconds(entries) {
  return (entries || []).reduce(
    (sum, entry) =>
      sum + roundToNearestFiveMinutes(entryDurationSeconds(entry)),
    0
  );
}

function groupEntriesByTag(entries) {
  const grouped = new Map();
  for (const entry of entries || []) {
    const tags =
      Array.isArray(entry.tags) && entry.tags.length
        ? entry.tags
        : ["(no label)"];
    for (const tag of tags) {
      if (!grouped.has(tag)) grouped.set(tag, []);
      grouped.get(tag).push(entry);
    }
  }
  return grouped;
}

function aggregateByDescription(entries) {
  const byDesc = new Map();

  for (const entry of entries || []) {
    const desc = entry.description || "No description";
    const roundedSeconds = roundToNearestFiveMinutes(
      entryDurationSeconds(entry)
    );

    if (!byDesc.has(desc)) byDesc.set(desc, 0);
    byDesc.set(desc, byDesc.get(desc) + roundedSeconds);
  }

  return Array.from(byDesc.entries())
    .map(([description, seconds]) => ({ description, seconds }))
    .sort((a, b) => b.seconds - a.seconds);
}

function filterEntriesForProject(entries) {
  if (!TOGGL_PROJECT_ID) return entries || [];
  return (entries || []).filter(
    (entry) => entry.project_id === TOGGL_PROJECT_ID
  );
}

/**
 * @param {any[]} entries
 */
function groupEntriesByStartDate(entries) {
  const grouped = new Map();

  for (const entry of entries || []) {
    if (!entry?.start) continue;

    const localDate = DateTime.fromISO(entry.start).setZone(TIMEZONE);
    if (!localDate.isValid) continue;

    const dateKey = localDate.toFormat("yyyy-LL-dd");
    if (!grouped.has(dateKey)) grouped.set(dateKey, []);
    grouped.get(dateKey).push(entry);
  }

  return grouped;
}

function buildDiscordMessage({
  todayEntries,
  todayTags,
  todayLabel,
  todayTotal,
}) {
  const header = `**${todayLabel}**`;
  const bodyLines = [];

  if (!todayEntries.length) {
    bodyLines.push("• No entries yet");
  } else {
    const grouped = groupEntriesByTag(todayEntries);

    for (const tag of todayTags) {
      const entriesForTag = grouped.get(tag.name) || [];
      const aggregated = aggregateByDescription(entriesForTag);
      bodyLines.push(`**${tag.name}**`);
      for (const { description, seconds } of aggregated) {
        bodyLines.push(`• ${description} 🕓  ${formatDuration(seconds)}`);
      }
    }

    if (bodyLines.length) {
      bodyLines.push("");
    }
    bodyLines.push(`Total: **${formatDuration(todayTotal)}**`);
  }

  const maxLen = Math.max(header.length, ...bodyLines.map((l) => l.length));
  const separator = "-".repeat(maxLen);

  return [header, separator, ...bodyLines].join("\n");
}

async function postToDiscord(content) {
  const webhookUrl = DISCORD_THREAD_ID
    ? `${DISCORD_WEBHOOK}?thread_id=${encodeURIComponent(DISCORD_THREAD_ID)}`
    : DISCORD_WEBHOOK;

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });

  if (!response.ok) {
    const errorText = await response
      .text()
      .catch(() => "<unable to read response>");
    throw new Error(`Discord webhook failed ${response.status}: ${errorText}`);
  }
}

function parseDateField(value, envName) {
  const trimmed = value?.trim();

  if (!trimmed) {
    throw new Error(
      `Invalid ${envName} provided (expected YYYY-MM-DD): empty value`
    );
  }

  const parsed = DateTime.fromFormat(trimmed, "yyyy-LL-dd", { zone: TIMEZONE });

  if (!parsed.isValid) {
    throw new Error(
      `Invalid ${envName} provided (expected YYYY-MM-DD): ${value}`
    );
  }

  return parsed;
}

function parseRunDate(value) {
  if (!value || value.toLowerCase() === "yesterday") {
    return DateTime.now().setZone(TIMEZONE).minus({ days: 1 });
  }

  if (value.toLowerCase() === "today") {
    return DateTime.now().setZone(TIMEZONE);
  }

  return parseDateField(value, "RUN_DATE");
}

function parseBackfillFromDate(value) {
  return parseDateField(value, "BACKFILL_FROM_DATE");
}

/**
 * @param {DateTime} runDate
 * @param {any[]} [entriesOverride]
 */
async function reportForDate(runDate, entriesOverride) {
  const filteredEntries = entriesOverride
    ? entriesOverride
    : filterEntriesForProject(
        await getTimeEntries(runDate.startOf("day"), runDate.startOf("day").plus({
          days: 1,
        }))
      );
  const dayLabel = runDate.toFormat("LLL dd"); // e.g., Dec 12

  if (!filteredEntries.length) {
    console.log(`No time entries for ${dayLabel}; skipping Discord post.`);
    return;
  }

  const dayTags = summarizeByTag(filteredEntries);
  const dayTotal = totalRoundedSeconds(filteredEntries);
  const message = buildDiscordMessage({
    todayEntries: filteredEntries,
    todayTags: dayTags,
    todayLabel: dayLabel,
    todayTotal: dayTotal,
  });

  if (DRY_RUN) {
    console.log(`[DRY RUN] Would post message for ${dayLabel}:\n`, message);
    return;
  }

  await postToDiscord(message);
  console.log(`Posted Toggl summary to Discord for ${dayLabel}`);
}

async function main() {
  try {
    if (BACKFILL_FROM_DATE) {
      const startDate = parseBackfillFromDate(BACKFILL_FROM_DATE).startOf("day");
      const yesterday = DateTime.now()
        .setZone(TIMEZONE)
        .minus({ days: 1 })
        .startOf("day");

      if (startDate > yesterday) {
        console.log(
          "BACKFILL_FROM_DATE is after yesterday; skipping Discord posts."
        );
        return;
      }

      const backfillEntries = filterEntriesForProject(
        await getTimeEntries(startDate, yesterday.plus({ days: 1 }))
      );
      const entriesByStartDate = groupEntriesByStartDate(backfillEntries);

      for (
        let currentDate = startDate;
        currentDate <= yesterday;
        currentDate = currentDate.plus({ days: 1 })
      ) {
        await reportForDate(
          currentDate,
          entriesByStartDate.get(currentDate.toFormat("yyyy-LL-dd")) || []
        );
      }
      return;
    }

    await reportForDate(parseRunDate(RUN_DATE));
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

main();
