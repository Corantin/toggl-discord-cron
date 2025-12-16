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
const authHeader = `Basic ${Buffer.from(`${TOGGL_TOKEN}:api_token`).toString(
  "base64"
)}`;

async function fetchJson(url, options = {}) {
  const headers = {
    Authorization: authHeader,
    ...(options.headers || {}),
  };

  const response = await fetch(url, { ...options, headers });

  if (!response.ok) {
    const errorText = await response
      .text()
      .catch(() => "<unable to read response>");
    throw new Error(
      `Request failed ${response.status} ${response.statusText}: ${errorText}`
    );
  }

  if (response.status === 204) return null;
  return response.json();
}

async function getTimeEntries(start, end) {
  const clampedStartMillis = Math.max(
    start.toMillis(),
    MIN_ENTRY_DATE.toMillis()
  );
  const clampedStart = DateTime.fromMillis(clampedStartMillis).toUTC();
  const url = `${API_BASE}/me/time_entries?start_date=${encodeURIComponent(
    clampedStart.toISO()
  )}&end_date=${encodeURIComponent(end.toUTC().toISO())}`;

  return fetchJson(url);
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

function parseRunDate(value) {
  if (!value || value.toLowerCase() === "yesterday") {
    return DateTime.now().setZone(TIMEZONE).minus({ days: 1 });
  }

  if (value.toLowerCase() === "today") {
    return DateTime.now().setZone(TIMEZONE);
  }

  const trimmed = value.trim();
  const parsed = DateTime.fromFormat(trimmed, "yyyy-LL-dd", { zone: TIMEZONE });

  if (!parsed.isValid) {
    throw new Error(
      `Invalid RUN_DATE provided (expected YYYY-MM-DD): ${value}`
    );
  }

  return parsed;
}

async function main() {
  try {
    const runDate = parseRunDate(RUN_DATE);
    const dayStart = runDate.startOf("day");
    const dayEnd = dayStart.plus({ days: 1 });
    const todayEntries = await getTimeEntries(dayStart, dayEnd);

    const filteredTodayEntries = filterEntriesForProject(todayEntries);

    const hasTodayEntries = filteredTodayEntries.length > 0;

    if (!hasTodayEntries) {
      console.log("No time entries for today; skipping Discord post.");
      return;
    }

    const todayTags = summarizeByTag(filteredTodayEntries);
    const todayLabel = runDate.toFormat("LLL dd"); // e.g., Dec 12
    const todayTotal = totalRoundedSeconds(filteredTodayEntries);

    const message = buildDiscordMessage({
      todayEntries: filteredTodayEntries,
      todayTags,
      todayLabel,
      todayTotal,
    });

    if (DRY_RUN) {
      console.log("[DRY RUN] Would post message:\n", message);
    } else {
      await postToDiscord(message);
      console.log("Posted Toggl summary to Discord");
    }
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

main();
