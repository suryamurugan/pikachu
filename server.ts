/// <reference types="node" />
/// <reference types="bun-types" />
// Bun + TypeScript GitHub → OpenProject helper server
// Usage:
//   bun run server.ts
//
// Environment variables required:
//   PORT                     – Port to listen on (default 3000)
//   GITHUB_WEBHOOK_SECRET    – Shared secret used when configuring GitHub webhooks
//   OPENPROJECT_BASE_URL     – Base URL of your OpenProject instance (e.g. https://openproject.example.com)
//   OPENPROJECT_API_KEY      – API key of the bot/user that will post comments
//   ENFORCE_GITHUB_SIGNATURE – "true" (default) to validate webhook signatures, set to "false" to skip verification

import { createHmac, timingSafeEqual } from "crypto";
import { Buffer } from "buffer";
import { serve } from "bun";
import { createWriteStream } from "fs";
import { once } from "events";

// Helper: verify GitHub signature (HMAC SHA-256)
function verifySignature(rawBody: string | ArrayBuffer, signatureHeader: string | null, secret: string): boolean {
  if (!signatureHeader || !secret) return false;
  const bodyBuf = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : Buffer.from(rawBody);
  const hmac = createHmac("sha256", secret);
  hmac.update(bodyBuf);
  const expected = `sha256=${hmac.digest("hex")}`;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false; // length mismatch
  }
}

// Helper: post a comment to an OpenProject work package
async function postOpenProjectComment(workPackageId: string, comment: string): Promise<void> {
  const baseUrl = process.env.OPENPROJECT_BASE_URL;
  const apiKey = process.env.OPENPROJECT_API_KEY;
  if (!baseUrl || !apiKey) {
    console.error("Missing OPENPROJECT_BASE_URL or OPENPROJECT_API_KEY env vars");
    return;
  }

  const url = `${baseUrl.replace(/\/$/, "")}/api/v3/work_packages/${workPackageId}/activities`;
  // OpenProject expects basic auth with username 'apikey' and the API key as the password
  const auth = Buffer.from(`apikey:${apiKey}`).toString("base64");

  const body = JSON.stringify({ comment: { raw: comment } });

  console.log("➡️  OpenProject POST", url);
  console.log("   Payload:", body);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Basic ${auth}`,
      "Accept": "application/json",
    },
    body,
  });

  const respText = await res.text();
  if (res.ok) {
    console.log(`✅ OpenProject response ${res.status}:`, respText);
  } else {
    console.error(`❌ OpenProject API error (${res.status}):`, respText);
  }
}

// Regex to capture work-package ID in branch names.
// Supported patterns:
//   1. op/<id>-...     (e.g., op/12-feature)
//   2. [op-<id>] ...   (legacy)
const OP_TAG_REGEX = /(?:\[op-(\d+)\]|op\/(\d+))/i;

// Should we verify GitHub webhook signatures?
const enforceSignature = (process.env.ENFORCE_GITHUB_SIGNATURE ?? "true").toLowerCase() !== "false";

// --- Logging to file -------------------------------------------------------
const logFilePath = process.env.LOG_FILE ?? "server.log";
const logStream = createWriteStream(logFilePath, { flags: "a" });

function writeToLogFile(...args: any[]) {
  const line = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
  logStream.write(`[${new Date().toISOString()}] ${line}\n`);
}

(["log", "warn", "error"] as const).forEach((level) => {
  const original = console[level];
  console[level] = (...args: any[]) => {
    original(...args); // keep printing to stdout/stderr
    writeToLogFile(...args);
  };
});

process.on("SIGINT", () => {
  console.log("Received SIGINT, shutting down.");
  logStream.end();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("Received SIGTERM, shutting down.");
  logStream.end();
  process.exit(0);
});
// --- End logging setup ----------------------------------------------------

// Cache of status IDs
let developedStatusId: string | null = null;
// Cache of the default task type id
let taskTypeId: string | null = null;

async function getDevelopedStatusId(): Promise<string | null> {
  // Manual override via env var
  const manualId = process.env.DEVELOPED_STATUS_ID;
  if (manualId) {
    developedStatusId = manualId;
    return developedStatusId;
  }

  if (developedStatusId) return developedStatusId;
  const baseUrl = process.env.OPENPROJECT_BASE_URL;
  const apiKey = process.env.OPENPROJECT_API_KEY;
  if (!baseUrl || !apiKey) return null;
  const auth = Buffer.from(`apikey:${apiKey}`).toString("base64");
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/v3/statuses`, {
    headers: { Accept: "application/json", Authorization: `Basic ${auth}` },
  });
  if (!res.ok) return null;
  const json: any = await res.json();
  const desiredName = (process.env.DEVELOPED_STATUS_NAME ?? "Developed").toLowerCase();
  const found = (json._embedded?.statuses ?? []).find((s: any) => s.name?.toLowerCase() === desiredName);
  if (found) {
    developedStatusId = String(found.id);
    console.log(`ℹ️  Cached status '${desiredName}' as ID ${developedStatusId}`);
    return developedStatusId;
  }
  console.warn(`⚠️  Status '${desiredName}' not found in OpenProject`);
  return null;
}

async function getTaskTypeId(): Promise<string | null> {
  // Allow overriding via env
  const envId = process.env.TASK_TYPE_ID;
  if (envId) {
    taskTypeId = envId;
    return taskTypeId;
  }

  if (taskTypeId) return taskTypeId;

  const baseUrl = process.env.OPENPROJECT_BASE_URL;
  const apiKey = process.env.OPENPROJECT_API_KEY;
  if (!baseUrl || !apiKey) return null;

  const auth = Buffer.from(`apikey:${apiKey}`).toString("base64");
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/v3/types`, {
    headers: { Accept: "application/json", Authorization: `Basic ${auth}` },
  });
  if (!res.ok) return null;
  const json: any = await res.json();
  const task = (json._embedded?.elements ?? []).find((t: any) => (t.name ?? "").toLowerCase() === "task");
  if (task) {
    taskTypeId = String(task.id);
    console.log(`ℹ️  Cached 'Task' type as ID ${taskTypeId}`);
    return taskTypeId;
  }
  console.warn("⚠️  Could not resolve Task type id from OpenProject");
  return null;
}

// Update work package status to "Developed"
async function setWorkPackageStatusDeveloped(workPackageId: string) {
  const baseUrl = process.env.OPENPROJECT_BASE_URL;
  const apiKey = process.env.OPENPROJECT_API_KEY;
  if (!baseUrl || !apiKey) return;
  const auth = Buffer.from(`apikey:${apiKey}`).toString("base64");

  // Fetch current WP to get lockVersion
  const wpUrl = `${baseUrl.replace(/\/$/, "")}/api/v3/work_packages/${workPackageId}`;
  const wpRes = await fetch(wpUrl, {
    headers: { Accept: "application/json", Authorization: `Basic ${auth}` },
  });
  if (!wpRes.ok) {
    console.error(`❌ Failed to fetch work package #${workPackageId} (${wpRes.status})`);
    return;
  }
  const wpJson: any = await wpRes.json();
  const lockVersion = wpJson.lockVersion;
  const statusId = await getDevelopedStatusId();
  if (!statusId) return;

  const patchBody = {
    lockVersion,
    _links: { status: { href: `/api/v3/statuses/${statusId}` } },
  };

  console.log(`🔄 Setting status of WP #${workPackageId} to Developed (ID ${statusId})`);
  const patchRes = await fetch(wpUrl, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify(patchBody),
  });
  const respText = await patchRes.text();
  if (patchRes.ok) {
    console.log(`✅ Work package #${workPackageId} status updated.`, respText);
  } else {
    console.error(`❌ Failed to update status (${patchRes.status}):`, respText);
  }
}

function extractWpIdFromString(text: string): string | null {
  const m = text.match(OP_TAG_REGEX);
  if (!m) return null;
  return m[1] || m[2] || null;
}

// Discord notification helper ------------------------------------------------
async function sendDiscordNotification(message: string, webhookUrl?: string) {
  const url = webhookUrl || process.env.DISCORD_WEBHOOK_URL;
  if (!url) {
    console.warn("DISCORD_WEBHOOK_URL not set; skipping Discord notification");
    return;
  }

  // Discord messages cannot exceed 2000 characters. We'll send in chunks ≤1900.
  const MAX_LEN = 1900;
  const chunks: string[] = [];
  let remaining = message;
  while (remaining.length > MAX_LEN) {
    let splitIdx = remaining.lastIndexOf("\n", MAX_LEN);
    if (splitIdx === -1 || splitIdx < 1500) {
      // No newline found in a reasonable window, hard split
      splitIdx = MAX_LEN;
    }
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }
  if (remaining.length) chunks.push(remaining);

  for (const chunk of chunks) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: chunk }),
      });
      if (!res.ok) {
        console.error(`❌ Discord webhook error ${res.status}`);
      }
    } catch (e) {
      console.error("❌ Discord webhook exception", e);
    }
  }
}

// ---- Helper to query OpenProject work packages with arbitrary filters ------
async function fetchWorkPackages(filters: any[]): Promise<any[]> {
  const baseUrl = process.env.OPENPROJECT_BASE_URL;
  const apiKey = process.env.OPENPROJECT_API_KEY;
  if (!baseUrl || !apiKey) {
    console.error("Missing OPENPROJECT_BASE_URL or OPENPROJECT_API_KEY env vars");
    return [];
  }
  const auth = Buffer.from(`apikey:${apiKey}`).toString("base64");
  const query = encodeURIComponent(JSON.stringify(filters));
  const url = `${baseUrl.replace(/\/$/, "")}/api/v3/work_packages?filters=${query}&pageSize=500&include=status,assignee,project`;
  console.log("➡️  OpenProject GET", url);
  const res = await fetch(url, {
    headers: { Accept: "application/json", Authorization: `Basic ${auth}` },
  });
  if (!res.ok) {
    console.error(`❌ OpenProject API error (${res.status}) when querying work packages`);
    return [];
  }
  const json: any = await res.json();
  return json._embedded?.elements ?? [];
}

function mapWpSummary(wp: any) {
  return {
    id: wp.id,
    subject: wp.subject,
    status:
      wp._embedded?.status?.name ??
      wp.status?.name ??
      wp._links?.status?.title ??
      "unknown",
    assignee:
      wp._embedded?.assignee?.name ??
      wp.assignee?.name ??
      wp._links?.assignee?.title ??
      null,
    project:
      wp._embedded?.project?.name ??
      wp._embedded?.project?.title ??
      wp.project?.name ??
      wp._links?.project?.title ??
      null,
    startDate: wp.startDate ?? wp.start_date ?? null,
    dueDate: wp.dueDate,
  };
}

// NEW: Reusable function that returns today's and overdue task summaries
export async function getTodaySummary(): Promise<{ today: any[]; overdue: any[]; in_progress: any[]; roadmaps: any[] }> {
  const taskId = await getTaskTypeId();

  // Tasks due today
  const dueTodayFilters = [
    { due_date: { operator: "t", values: [] } }, // today
    ...(taskId ? [{ type: { operator: "=", values: [taskId] } }] : []),
  ];

  // Overdue tasks (due date before today)
  const overdueFilters = [
    { due_date: { operator: "<t-", values: ["0"] } }, // before today
    ...(taskId ? [{ type: { operator: "=", values: [taskId] } }] : []),
  ];

  // All open tasks (to derive "in progress")
  const openFilters = [
    { status: { operator: "o", values: [] } },
    ...(taskId ? [{ type: { operator: "=", values: [taskId] } }] : []),
  ];

  const [todayWps, overdueWps, openWps] = await Promise.all([
    fetchWorkPackages(dueTodayFilters),
    fetchWorkPackages(overdueFilters),
    fetchWorkPackages(openFilters),
  ]);

  // Filter helper – consider a work-package open if status.isClosed !== true
  const isOpen = (wp: any): boolean => {
    const embeddedStatus = wp._embedded?.status;

    // 1. Prefer explicit boolean flag if available
    if (embeddedStatus && typeof embeddedStatus.isClosed === "boolean") {
      return !embeddedStatus.isClosed;
    }

    // 2. Check embedded status name
    if (embeddedStatus?.name) {
      return embeddedStatus.name.toString().toLowerCase() !== "closed";
    }

    // 3. Fallback to _links.status.title (often present when not embedded)
    const linkStatusTitle = wp._links?.status?.title;
    if (linkStatusTitle) {
      return linkStatusTitle.toString().toLowerCase() !== "closed";
    }

    // 4. Finally, inspect status id from href (e.g., /api/v3/statuses/11)
    const href: string | undefined = wp._links?.status?.href;
    if (href) {
      const idStr = href.split("/").pop();
      const idNum = Number(idStr);
      if (!Number.isNaN(idNum)) {
        // Convention in this project: status id > 8 considered closed/completed
        return idNum <= 8;
      }
    }

    // If in doubt, treat as open (so we don't accidentally hide tasks)
    return true;
  };

  const todayOpen = todayWps.filter(isOpen);
  const todayIds = new Set(todayOpen.map((wp: any) => wp.id));
  const overdueOpen = overdueWps.filter(isOpen).filter((wp: any) => !todayIds.has(wp.id));

  const combinedExcludedIds = new Set([
    ...todayOpen.map((wp: any) => wp.id),
    ...overdueOpen.map((wp: any) => wp.id),
  ]);

  const isStatusInProgress = (wp: any): boolean => {
    const name =
      wp._embedded?.status?.name ??
      wp.status?.name ??
      wp._links?.status?.title ??
      "";
    return name.toString().toLowerCase() === "in progress";
  };

  const inProgress = openWps
    .filter(isOpen)
    .filter(isStatusInProgress)
    .filter((wp: any) => !combinedExcludedIds.has(wp.id));

  // Fetch roadmap (version) stats as well
  const roadmaps = await getRoadmaps();

  return {
    today: todayOpen.map(mapWpSummary),
    overdue: overdueOpen.map(mapWpSummary),
    in_progress: inProgress.map(mapWpSummary),
    roadmaps,
  };
}

// Helper: build markdown table for Discord messages
function buildMarkdownTable(
  headers: string[],
  rows: (string | number | null)[][],
  fixedWidths?: number[],
): string {
  if (!rows.length) return "_No tasks_";
  const allRows = [headers, ...rows];
  const colWidths = headers.map((_, idx) => {
    const computed = Math.max(...allRows.map((r) => String(r[idx] ?? "").length));
    return fixedWidths && fixedWidths[idx] ? Math.max(fixedWidths[idx], computed) : computed;
  });
  const pad = (val: string, len: number) => val + " ".repeat(len - val.length);
  const formatRow = (row: any[]) =>
    "|" + row.map((cell, idx) => pad(String(cell ?? ""), colWidths[idx])).join("|") + "|";
  const lines = [
    formatRow(headers),
    "|" + colWidths.map((w) => "-".repeat(w)).join("|") + "|",
    ...rows.map(formatRow),
  ];
  return lines.join("\n");
}

// ------------------------ NEW HTML SUMMARY HELPERS ------------------------

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildHtmlSummary(summary: { today: any[]; overdue: any[]; in_progress?: any[]; roadmaps?: any[] }): string {
  const todayStr = new Date().toISOString().slice(0, 10);
  const base = (process.env.OPENPROJECT_BASE_URL ?? "").replace(/\/$/, "");

  const renderRows = (items: any[]) =>
    items
      .map((wp) => {
        const subject = escapeHtml(wp.subject ?? "");
        const status = escapeHtml(wp.status ?? "");
        const assignee = escapeHtml(wp.assignee ?? "—");
        const project = escapeHtml(wp.project ?? "—");
        const due = wp.dueDate ? escapeHtml(wp.dueDate) : "—";
        const url = base ? `${base}/work_packages/${wp.id}` : "#";
        return `<tr>
          <td><a href="${url}" target="_blank">#${wp.id}</a></td>
          <td>${subject}</td>
          <td>${status}</td>
          <td>${assignee}</td>
          <td>${project}</td>
          <td>${due}</td>
        </tr>`;
      })
      .join("\n");

  const section = (title: string, items: any[]) => {
    if (!items.length) {
      return `<h2>${title}</h2><p><em>No tasks</em></p>`;
    }
    return `<h2>${title}</h2>
      <table>
        <thead>
          <tr><th>ID</th><th>Subject</th><th>Status</th><th>Assignee</th><th>Project</th><th>Due</th></tr>
        </thead>
        <tbody>
          ${renderRows(items)}
        </tbody>
      </table>`;
  };

  const parts = [`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Daily Task Summary ${todayStr}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 2rem; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 2rem; }
    th, td { border: 1px solid #ccc; padding: 6px 10px; text-align: left; }
    th { background: #f0f0f0; }
    a { color: #0366d6; text-decoration: none; }
    .progress-bar { width: 100px; background: #eee; border: 1px solid #ccc; height: 10px; position: relative; }
    .progress-bar span { display: block; height: 100%; background: #4caf50; }
  </style>
</head>
<body>
  <h1>📋 Daily Task Summary (${todayStr})</h1>`];

  parts.push(section("Due Today", summary.today));
  if (summary.in_progress && summary.in_progress.length) {
    parts.push(section("In Progress", summary.in_progress));
  }
  parts.push(section("Overdue Tasks", summary.overdue));

  // Roadmaps section
  if (summary.roadmaps && summary.roadmaps.length) {
    const rows = summary.roadmaps
      .map((r: any) => {
        const versionUrl = base ? `${base}/versions/${r.id}` : "#";
        const progressBar = `<div class="progress-bar"><span style="width:${r.progress}%"></span></div>`;
        const progressText = `${r.progress}%`;
        const nameCol = `<a href="${versionUrl}" target="_blank">${escapeHtml(r.name ?? "Version")}</a>`;
        const status = escapeHtml(r.status ?? "–");
        return `<tr>
          <td>#${r.id}</td>
          <td>${nameCol}</td>
          <td>${status}</td>
          <td>${r.closedWorkPackages}/${r.totalWorkPackages}</td>
          <td>${progressBar} ${progressText}</td>
        </tr>`;
      })
      .join("\n");

    parts.push(`<h2>Roadmaps</h2>
      <table>
        <thead>
          <tr><th>ID</th><th>Name</th><th>Status</th><th>Closed/Total</th><th>Progress</th></tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>`);
  }

  parts.push("</body>\n</html>");

  return parts.join("\n");
}
// ---------------------- END HTML SUMMARY HELPERS -------------------------

// Format the daily summary into a Discord-friendly markdown message
async function formatDailySummaryMessage(): Promise<string> {
  const summary = await getTodaySummary();
  const todayStr = new Date().toISOString().slice(0, 10);

  function truncate(str: string, max = 30) {
    return str.length > max ? str.slice(0, max - 3) + "..." : str;
  }

  const formatItem = (wp: any, includeDue = false) => {
    const parts = [
      `**#${wp.id}**`,
      truncate(wp.subject, 40),
      `(${wp.status})`,
      wp.assignee ? `— ${wp.assignee}` : "",
      includeDue && wp.dueDate ? `— Due ${wp.dueDate}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return `• ${parts}`;
  };

  const todayList = summary.today.map((wp) => formatItem(wp)).join("\n");
  const inProgressList = (summary.in_progress ?? []).map((wp) => formatItem(wp, true)).join("\n");
  const overdueList = summary.overdue.map((wp) => formatItem(wp, true)).join("\n");

  // Roadmaps bullets
  const roadmapItems = (summary.roadmaps ?? [])
    .map((r: any) => {
      const name = truncate(r.name ?? `Version ${r.id}`, 40);
      return `• **${name}** (#${r.id}) — ${r.progress}% (${r.closedWorkPackages}/${r.totalWorkPackages} closed)`;
    })
    .join("\n");

  const lines = [
    `📋 **Daily Task Summary (${todayStr})**`,
    "",
    "**Due Today:**",
    todayList || "No tasks due today.",
  ];

  if (inProgressList) {
    lines.push("", "**In Progress:**", inProgressList);
  }

  lines.push("", "**Overdue Tasks:**", overdueList || "No overdue tasks.");

  if (roadmapItems) {
    lines.push("", "**Roadmaps:**", roadmapItems);
  }

  return lines.join("\n");
}

// Scheduler: run at configured times each day to send the summary to Discord
function scheduleDailySummaries() {
  const timesEnv = process.env.DAILY_SUMMARY_TIMES; // e.g., "12:00,16:00,20:30"
  if (!timesEnv) {
    console.log("ℹ️  DAILY_SUMMARY_TIMES not set; daily summaries disabled");
    return;
  }

  const times = timesEnv.split(/[,;\s]+/).filter(Boolean);
  if (!times.length) return;

  function scheduleForTime(timeStr: string) {
    const [hStr, mStr = "0"] = timeStr.split(":");
    const hour = Number(hStr);
    const minute = Number(mStr);
    if (isNaN(hour) || hour < 0 || hour > 23 || isNaN(minute) || minute < 0 || minute > 59) {
      console.warn(`⚠️  Invalid DAILY_SUMMARY_TIMES entry '${timeStr}', skipping`);
      return;
    }

    const scheduleNext = () => {
      const now = new Date();
      const next = new Date(now);
      next.setHours(hour, minute, 0, 0);
      if (next <= now) {
        next.setDate(now.getDate() + 1);
      }
      const delay = next.getTime() - now.getTime();
      console.log(`⏰ Scheduled daily summary for ${timeStr} in ${Math.round(delay / 1000)}s`);
      setTimeout(async () => {
        try {
          const content = await formatDailySummaryMessage();
          await sendDiscordNotification(content, process.env.DISCORD_SUMMARY_WEBHOOK_URL || undefined);
          console.log("✅ Daily summary sent to Discord (" + timeStr + ")");
        } catch (e) {
          console.error("❌ Failed to send daily summary", e);
        }
        scheduleNext(); // reschedule for next day
      }, delay);
    };

    scheduleNext();
  }

  times.forEach(scheduleForTime);
}

// ------------------------ ROADMAP (VERSIONS) HELPERS ------------------------

async function fetchRoadmaps(): Promise<any[]> {
  const baseUrl = process.env.OPENPROJECT_BASE_URL;
  const apiKey = process.env.OPENPROJECT_API_KEY;
  if (!baseUrl || !apiKey) {
    console.error("Missing OPENPROJECT_BASE_URL or OPENPROJECT_API_KEY env vars");
    return [];
  }

  const auth = Buffer.from(`apikey:${apiKey}`).toString("base64");
  const url = `${baseUrl.replace(/\/$/, "")}/api/v3/versions?pageSize=500&include=project`;
  console.log("➡️  OpenProject GET", url);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", Authorization: `Basic ${auth}` },
    });
    if (!res.ok) {
      console.error(`❌ OpenProject API error (${res.status}) when querying roadmaps`);
      return [];
    }
    const json: any = await res.json();
    return json._embedded?.elements ?? [];
  } catch (e) {
    console.error("❌ Exception while fetching roadmaps", e);
    return [];
  }
}

// Helper: generic count query for work packages given OpenProject filter JSON
async function fetchWpCount(filters: any[]): Promise<number> {
  const baseUrl = process.env.OPENPROJECT_BASE_URL;
  const apiKey = process.env.OPENPROJECT_API_KEY;
  if (!baseUrl || !apiKey) return 0;

  const auth = Buffer.from(`apikey:${apiKey}`).toString("base64");
  const qs = new URLSearchParams();
  qs.set("filters", JSON.stringify(filters));
  qs.set("pageSize", "1"); // minimal payload – we only need the collection meta

  const url = `${baseUrl.replace(/\/$/, "")}/api/v3/work_packages?${qs.toString()}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", Authorization: `Basic ${auth}` },
    });
    if (!res.ok) {
      console.warn(`⚠️  OpenProject API responded ${res.status} when counting WPs for filters ${qs.get("filters")}`);
      return 0;
    }
    const json: any = await res.json();
    // Work package collection responses include `total` with overall count
    return typeof json.total === "number" ? json.total : 0;
  } catch (e) {
    console.error("❌ Exception while counting work packages", e);
    return 0;
  }
}

function mapRoadmapSummary(v: any) {
  return {
    id: v.id,
    name: v.name,
    description: v.description?.raw ?? v.description?.html ?? null,
    status: v.status ?? v._links?.status?.title ?? null,
    sharing: v.sharing ?? null,
    startDate: v.startDate ?? v.start_date ?? null,
    dueDate: v.dueDate ?? v.due_date ?? null,
    createdAt: v.createdAt ?? v.created_at ?? null,
    updatedAt: v.updatedAt ?? v.updated_at ?? null,
    project: v._embedded?.project?.name ?? v._links?.project?.title ?? null,
    projectId: v._embedded?.project?.id ?? null,
  };
}

export async function getRoadmaps(): Promise<any[]> {
  const versions = await fetchRoadmaps();
  // Enrich each roadmap with work-package statistics in parallel
  const enriched = await Promise.all(
    versions.map(async (v: any) => {
      const baseSummary = mapRoadmapSummary(v);

      // Total work packages linked to this version
      const filtersBase = [{ version: { operator: "=", values: [String(v.id)] } }];
      const total = await fetchWpCount(filtersBase);

      // Closed work packages (status operator "c")
      const filtersClosed = [...filtersBase, { status: { operator: "c", values: [] } }];
      const closed = await fetchWpCount(filtersClosed);

      const progress = total === 0 ? 0 : Math.round((closed / total) * 100);

      return {
        ...baseSummary,
        totalWorkPackages: total,
        closedWorkPackages: closed,
        progress,
      };
    }),
  );

  return enriched;
}

// ---------------------- END ROADMAP HELPERS -------------------------

// ------------------------ USERS HELPERS ------------------------

async function fetchUsers(): Promise<any[]> {
  const baseUrl = process.env.OPENPROJECT_BASE_URL;
  const apiKey = process.env.OPENPROJECT_API_KEY;
  if (!baseUrl || !apiKey) {
    console.error("Missing OPENPROJECT_BASE_URL or OPENPROJECT_API_KEY env vars");
    return [];
  }

  const auth = Buffer.from(`apikey:${apiKey}`).toString("base64");
  const principalsUrl = `${baseUrl.replace(/\/$/, "")}/api/v3/principals?pageSize=500`;
  console.log("➡️  OpenProject GET", principalsUrl);
  try {
    const res = await fetch(principalsUrl, {
      headers: { Accept: "application/json", Authorization: `Basic ${auth}` },
    });
    if (!res.ok) {
      console.error(`❌ OpenProject API error (${res.status}) when querying principals`);
      return [];
    }
    const json: any = await res.json();
    const all: any[] = json._embedded?.elements ?? [];
    return all.filter((p) => p._type === "User");
  } catch (e) {
    console.error("❌ Exception while fetching users", e);
    return [];
  }
}

function mapUserSummary(u: any) {
  const composedName = `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim();
  const nameResolved = u.name ?? (composedName ? composedName : null);
  return {
    id: u.id,
    name: nameResolved,
    username: u.login ?? u.username ?? null,
    email: u.email ?? u.mail ?? null,
  };
}

// --------------------------------------------------------------------------
// Static user records that should always be present in /users output even if
// the API account cannot see them (e.g. external bots, service accounts).
// Extend or modify as needed.
const STATIC_USERS = [
{
"id": 22,
"name": "Ranjani MN",
"username": "1384785830203359284",
"email": "ranjani.mn@xcelerator.co.in"
},
{
"id": 21,
"name": "Aakriti Bansal",
"username": "1384781843425136701",
"email": "aakriti@xcelerator.co.in"
},
{
"id": 20,
"name": "Prashanth Xcelerator",
"username": "851151237482676224",
"email": "prashanth@xcelerator.co.in"
},
{
"id": 19,
"name": "chetan J",
"username": "1372459213124534364",
"email": "chetan@xcelerator.co.in"
},
{
"id": 18,
"name": "Savitha Prakash",
"username": "1384821992380825610",
"email": "savitha@xcelerator.co.in"
},
{
"id": 17,
"name": "Anju Reddy K",
"username": "1308774878421454978",
"email": "anju@xcelerator.co.in"
},
{
"id": 16,
"name": "Arpitha HR",
"username": "1331213092415209472",
"email": "arpitha@xcelerator.co.in"
},
{
"id": 15,
"name": "Ashish Yadav",
"username": "1360127230440771775",
"email": "ashish@xcelerator.co.in"
},
{
"id": 14,
"name": "Neeraj H N",
"username": "1011277746569236520",
"email": "neeraj@xcelerator.co.in"
},
{
"id": 13,
"name": "Pooja Gondi",
"username": "pooja@xcelerator.co.in",
"email": "pooja@xcelerator.co.in"
},
{
"id": 12,
"name": "Rajani Kalyani K S",
"username": "1307937048081989645",
"email": "rajani@xcelerator.co.in"
},
{
"id": 11,
"name": "Ranjan SB",
"username": "1176863192538943508",
"email": "ranjan@xcelerator.co.in"
},
{
"id": 10,
"name": "Shreenath G L",
"username": "1194194201831800924",
"email": "shreenath@xcelerator.co.in"
},
{
"id": 9,
"name": "john karamchand",
"username": "540940684962824192",
"email": "john@xcelerator.co.in"
},
{
"id": 8,
"name": "raj sharma",
"username": "509004765380739107",
"email": "raj@xcelerator.co.in"
},
{
"id": 7,
"name": "Sujan Kumar",
"username": "757931923275382825",
"email": "sujan@xcelerator.co.in"
},
{
"id": 6,
"name": "Github User",
"username": "engineering@xcelerator.co.in",
"email": "engineering@xcelerator.co.in"
},
{
"id": 5,
"name": "surya murugan",
"username": "440449131085824001",
"email": "surya@xcelerator.co.in"
},
{
"id": 4,
"name": "OpenProject Admin",
"username": "admin",
"email": "it@xcelerator.co.in"
}
];

// NEW: helper to build Discord mention for a given assignee name
function discordTag(assigneeName?: string | null): string {
  if (!assigneeName) return "";
  const match = STATIC_USERS.find(
    (u) => typeof u.name === "string" && u.name.toLowerCase() === assigneeName.toLowerCase(),
  );
  if (match && match.username) {
    return `<@${match.username}>`;
  }
  return assigneeName;
}

// NEW: core logic to send reminders to assignees for due-today and overdue tasks
async function sendDueUsersReminders(): Promise<{ today: number; overdue: number }> {
  const summary = await getTodaySummary();
  const base = (process.env.OPENPROJECT_BASE_URL ?? "").replace(/\/$/, "");
  const webhook =
    process.env.DISCORD_DUE_USERS_WEBHOOK_URL ||
    process.env.DISCORD_SUMMARY_WEBHOOK_URL ||
    undefined;

  const truncate = (s: string, max = 80) => (s.length > max ? s.slice(0, max - 3) + "..." : s);

  const notify = async (
    wps: any[],
    prefixEmoji: string,
    tag: string,
    instruction: string,
  ) => {
    for (const wp of wps) {
      const mention = discordTag(wp.assignee);
      const url = base ? `${base}/work_packages/${wp.id}` : "#";
      const dueLine = wp.dueDate ? `Due **${wp.dueDate}**` : undefined;
      const parts = [
        `${prefixEmoji} **${tag}**`,
        `${mention} – **#${wp.id}**: *${truncate(wp.subject)}*`,
        dueLine,
        instruction,
        url,
      ].filter(Boolean);
      const msg = parts.join("\n");
      await sendDiscordNotification(msg, webhook);
    }
  };

  await notify(
    summary.today,
    "📌",
    "DUE TODAY",
    "Please update the status of the task is in expected timeline.",
  );
  await notify(
    summary.overdue,
    "⏰",
    "OVER_DUE",
    "Please close the task asap or talk to the team to update it.",
  );

  return { today: summary.today.length, overdue: summary.overdue.length };
}

// NEW: scheduler for due-user reminders driven by env var DUE_USERS_TIMES
function scheduleDueUsersReminders() {
  const timesEnv = process.env.DUE_USERS_TIMES; // e.g., "09:00,14:00"
  if (!timesEnv) {
    console.log("ℹ️  DUE_USERS_TIMES not set; due-user reminders disabled");
    return;
  }

  const times = timesEnv.split(/[,;\s]+/).filter(Boolean);
  if (!times.length) return;

  function scheduleForTime(timeStr: string) {
    const [hStr, mStr = "0"] = timeStr.split(":");
    const hour = Number(hStr);
    const minute = Number(mStr);
    if (
      isNaN(hour) ||
      hour < 0 ||
      hour > 23 ||
      isNaN(minute) ||
      minute < 0 ||
      minute > 59
    ) {
      console.warn(`⚠️  Invalid DUE_USERS_TIMES entry '${timeStr}', skipping`);
      return;
    }

    const scheduleNext = () => {
      const now = new Date();
      const next = new Date(now);
      next.setHours(hour, minute, 0, 0);
      if (next <= now) {
        next.setDate(now.getDate() + 1);
      }
      const delay = next.getTime() - now.getTime();
      console.log(
        `⏰ Scheduled due-user reminder for ${timeStr} in ${Math.round(delay / 1000)}s`,
      );
      setTimeout(async () => {
        try {
          const counts = await sendDueUsersReminders();
          console.log(
            `✅ Due-user reminders sent (${timeStr}) – today: ${counts.today}, overdue: ${counts.overdue}`,
          );
        } catch (e) {
          console.error("❌ Failed to send due-user reminders", e);
        }
        scheduleNext(); // reschedule for next day
      }, delay);
    };

    scheduleNext();
  }

  times.forEach(scheduleForTime);
}

export async function getUsers(): Promise<any[]> {
  const principals = await fetchUsers();
  const baseUrl = process.env.OPENPROJECT_BASE_URL;
  const apiKey = process.env.OPENPROJECT_API_KEY;
  if (!baseUrl || !apiKey) return [];
  const auth = Buffer.from(`apikey:${apiKey}`).toString("base64");

  const detailed = await Promise.all(
    principals.map(async (p: any) => {
      const id = p.id;
      // Try /users/{id} first
      const userUrl = `${baseUrl.replace(/\/$/, "")}/api/v3/users/${id}`;
      try {
        const res = await fetch(userUrl, { headers: { Accept: "application/json", Authorization: `Basic ${auth}` } });
        if (res.ok) {
          const uj = await res.json();
          return uj;
        }
      } catch {}

      // Fallback to principal detail
      const principalUrl = `${baseUrl.replace(/\/$/, "")}/api/v3/principals/${id}`;
      try {
        const res = await fetch(principalUrl, { headers: { Accept: "application/json", Authorization: `Basic ${auth}` } });
        if (res.ok) return await res.json();
      } catch {}

      return p; // return original minimal
    }),
  );

  const mapped = detailed.map(mapUserSummary);

  // Merge with static list (do not duplicate entries that already exist)
  const existingIds = new Set(mapped.map((u: any) => u.id));
  const merged = [...mapped, ...STATIC_USERS.filter((u) => !existingIds.has(u.id))];

  return merged;
}

// --------------------------------------------------------------------------

serve({
  port: Number(process.env.PORT ?? 3000),
  async fetch(req) {
    const { pathname } = new URL(req.url);
    console.log(`🌐 ${req.method} ${pathname}`);

    // Health-check endpoint ➜ always 200 OK JSON
    if (req.method === "GET" && pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Summary of today's and overdue tasks
    if (req.method === "GET" && pathname === "/getTodaySummary") {
      const summary = await getTodaySummary();
      return new Response(JSON.stringify(summary), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // NEW: HTML view of today's and overdue tasks
    if (req.method === "GET" && pathname === "/getTodaySummaryView") {
      const summary = await getTodaySummary();
      const html = buildHtmlSummary(summary);
      return new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Fetch all OpenProject roadmaps (versions)
    if (req.method === "GET" && pathname === "/getRoadmaps") {
      const roadmaps = await getRoadmaps();
      return new Response(JSON.stringify(roadmaps), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Fetch all users (id, name, username, email)
    if (req.method === "GET" && pathname === "/users") {
      const users = await getUsers();
      return new Response(JSON.stringify(users), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Trigger daily summary to Discord immediately
    if (req.method === "GET" && pathname === "/triggerNow") {
      try {
        const msg = await formatDailySummaryMessage();
        await sendDiscordNotification(msg, process.env.DISCORD_SUMMARY_WEBHOOK_URL || undefined);
        return new Response(JSON.stringify({ status: "sent" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        console.error("❌ Failed to send on-demand summary", e);
        return new Response("Error", { status: 500 });
      }
    }

    // NEW: Trigger due-date reminders to individual users
    if (req.method === "GET" && pathname === "/triggerDueUsers") {
      try {
        const counts = await sendDueUsersReminders();
        return new Response(
          JSON.stringify({ status: "sent", today: counts.today, overdue: counts.overdue }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      } catch (e) {
        console.error("❌ Failed to send due-user notifications", e);
        return new Response("Error", { status: 500 });
      }
    }

    // OpenProject webhook endpoint — handle before reading body elsewhere
    if (req.method === "POST" && pathname === "/op-update") {
      const bodyText = await req.text();
      let payload: any;
      try {
        payload = JSON.parse(bodyText);
      } catch {
        return new Response("Bad JSON", { status: 400 });
      }

      if (payload.action === "work_package:updated") {
        const statusObj = payload.work_package?.status ?? payload.work_package?._embedded?.status ?? {};
        const statusIdRaw = statusObj.id;
        const statusId = Number(statusIdRaw);
        const statusName = statusObj.name ?? `Status ${statusId}`;
        console.log("raw", statusIdRaw);
        console.log("id:", statusId);
        console.log("type:", typeof statusId);
        console.log(typeof statusId === "number" && statusId > 8);
        if (typeof statusId === "number" && statusId > 8) {
          console.log("🔔 Sending Discord notification for WP update now");
          const wpId = payload.work_package?.id;
          const subject = payload.work_package?.subject ?? "WP";
          const project = payload.work_package?._embedded?.project?.identifier ?? "project";
          const base = process.env.OPENPROJECT_BASE_URL ?? "";
          const wpUrl = `${base}/work_packages/${wpId}`;
          const msg = `🛠️ Work package **#${wpId} - ${subject}** in project **${project}** moved to **${statusName}**.\n${wpUrl}`;
          console.log("📨 Sending Discord message:", msg);
          await sendDiscordNotification(msg);
        }
      } else if (payload.action === "work_package:created") {
        // New work package created → notify Discord (if webhook configured)
        const wpId = payload.work_package?.id;
        const subject = payload.work_package?.subject ?? "Work package";
        const project = payload.work_package?._embedded?.project?.identifier ?? "project";
        const author = payload.work_package?._embedded?.author?.name ?? "someone";
        const base = process.env.OPENPROJECT_BASE_URL ?? "";
        const wpUrl = `${base}/work_packages/${wpId}`;
        const msg = `🆕 Work package **#${wpId} - ${subject}** created in project **${project}** by **${author}**.\n${wpUrl}`;
        console.log("🔔 Sending Discord notification for WP creation now");
        console.log("📨 Sending Discord message:", msg);
        await sendDiscordNotification(msg);
      }

      return new Response("OK", { status: 200 });
    }

    // ---- GitHub webhook handling below (may read body for signature) ----
    if (req.method !== "POST") {
      return new Response("Not Found", { status: 404 });
    }

    const signature = req.headers.get("x-hub-signature-256");
    const secret = process.env.GITHUB_WEBHOOK_SECRET ?? "";

    // GitHub will send JSON; we need raw body for signature verification
    const rawBody = await req.text();

    console.log("🔔 Incoming request", {
      ip: req.headers.get("x-forwarded-for") ?? "unknown",
      event: req.headers.get("x-github-event"),
      delivery: req.headers.get("x-github-delivery"),
    });

    if (enforceSignature) {
      if (!verifySignature(rawBody, signature, secret)) {
        console.warn("⚠️  Signature verification failed");
        return new Response("Invalid signature", { status: 401 });
      }
    } else {
      console.warn("⚠️  Signature verification is DISABLED (ENFORCE_GITHUB_SIGNATURE=false)");
    }

    // Now safe to parse JSON
    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      console.error("❌ Could not parse JSON payload");
      return new Response("Bad JSON", { status: 400 });
    }

    const event = req.headers.get("x-github-event");

    // Branch creation events
    if (event === "create" && payload.ref_type === "branch") {
      const branchName: string = payload.ref;
      const match = branchName.match(OP_TAG_REGEX);
      if (match) {
        const workPackageId = match[1] || match[2];
        const repoName: string = payload.repository?.full_name ?? "unknown repo";
        const branchUrl = `https://github.com/${repoName}/tree/${encodeURIComponent(branchName)}`;
        const comment = `🔀 Branch [\`${branchName}\`](${branchUrl}) created in GitHub repository **${repoName}**.`;
        console.log(`📝 Posting comment to OpenProject work package #${workPackageId}`);
        await postOpenProjectComment(workPackageId, comment);
        console.log("✅ Comment posted");
      }
    }

    // Push events: one or more commits pushed to a branch
    if (event === "push") {
      const fullRef: string = payload.ref; // e.g., refs/heads/op/12-feature
      const branchName = fullRef.replace(/^refs\/heads\//, "");
      const match = branchName.match(OP_TAG_REGEX);
      if (match) {
        const workPackageId = match[1] || match[2];
        const repoName: string = payload.repository?.full_name ?? "unknown repo";

        const commits: any[] = payload.commits ?? [];
        for (const c of commits) {
          const sha: string = c.id;
          const shortSha = sha.substring(0, 7);
          const commitUrl = `https://github.com/${repoName}/commit/${sha}`;
          const msg = c.message.split("\n")[0];
          const comment = `📦 Commit [\`${shortSha}\`](${commitUrl}) pushed to branch \`${branchName}\`: ${msg}`;
          console.log(`📝 Posting commit comment (${shortSha}) to work package #${workPackageId}`);
          await postOpenProjectComment(workPackageId, comment);
        }
        if (commits.length) console.log("✅ Commit comments posted");
      }
    }

    // Pull request closed (merged) -> update status
    if (event === "pull_request" && payload.action === "closed" && payload.pull_request?.merged) {
      const branchName: string = payload.pull_request.head.ref;
      let workPackageId = extractWpIdFromString(branchName);
      if (!workPackageId) {
        workPackageId = extractWpIdFromString(payload.pull_request.title ?? "");
      }
      if (workPackageId) {
        const prNumber: number = payload.number;
        const prTitle: string = payload.pull_request.title ?? "Pull Request";
        const prUrl: string = payload.pull_request.html_url;

        const mergeComment = `✅ Pull request [#${prNumber}: ${prTitle}](${prUrl}) merged into **${payload.repository?.full_name ?? "repo"}**.`;
        console.log(`📝 Posting merge comment (#${prNumber}) to work package #${workPackageId}`);
        await postOpenProjectComment(workPackageId, mergeComment);

        console.log(`🔧 Updating WP #${workPackageId} status to Developed`);
        await setWorkPackageStatusDeveloped(workPackageId);
      }
    }

    // Pull request opened -> leave a comment
    if (event === "pull_request" && ["opened", "reopened", "ready_for_review"].includes(payload.action)) {
      const branchName: string = payload.pull_request.head.ref;
      let workPackageId = extractWpIdFromString(branchName);
      if (!workPackageId) {
        workPackageId = extractWpIdFromString(payload.pull_request.title ?? "");
      }
      if (workPackageId) {
        const repoName: string = payload.repository?.full_name ?? "unknown repo";
        const prNumber: number = payload.number;
        const prTitle: string = payload.pull_request.title ?? "Pull Request";
        const prUrl: string = payload.pull_request.html_url;
        const comment = `🚀 Pull request [#${prNumber}: ${prTitle}](${prUrl}) opened targeting branch \`${branchName}\` in **${repoName}**.`;
        console.log(`📝 Posting PR comment (#${prNumber}) to work package #${workPackageId}`);
        await postOpenProjectComment(workPackageId, comment);
      }
    }

    // New comment on PR -> propagate to WP
    if (event === "issue_comment" && payload.action === "created" && payload.issue?.pull_request) {
      const prTitle: string = payload.issue.title ?? "";
      const workPackageId = extractWpIdFromString(prTitle);
      if (workPackageId) {
        const repoName: string = payload.repository?.full_name ?? "repo";
        const prNumber: number = payload.issue.number;
        const commentUser: string = payload.comment?.user?.login ?? "someone";
        const commentBody: string = (payload.comment?.body ?? "").split("\n")[0];
        const commentUrl: string = payload.comment?.html_url;
        const wpComment = `💬 Comment by **@${commentUser}** on PR [#${prNumber}](${commentUrl}) in **${repoName}**: ${commentBody}`;
        console.log(`📝 Posting PR comment from ${commentUser} to WP #${workPackageId}`);
        await postOpenProjectComment(workPackageId, wpComment);
      }
    }

    // Respond quickly to GitHub (must be <10s)
    return new Response("OK", { status: 200 });
  },
});

const effectivePort = Number(process.env.PORT ?? 3000);
console.log(`🚀 Pikachu helper listening on port ${effectivePort}`);

// Kick off daily summary scheduler after server start
scheduleDailySummaries();
// Kick off due-user reminder scheduler after server start
scheduleDueUsersReminders();
