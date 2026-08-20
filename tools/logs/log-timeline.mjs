#!/usr/bin/env node
// daemon conn-log timeline: one command that answers "which minute did connections start
// climbing, how fast, and was there a cadence" straight from the daemon conn JSONL logs.
//
//   node tools/logs/log-timeline.mjs [--user-root <dir>] [--daemon-id default]
//        [--since <ISO|YYYY-MM-DD|HH:MM|-90m>] [--until <t>] [--method <substr>] [--conn c-12]
//        [--top 10] [--file <path>]...
//
// Records are daemon-conn-log/v1 JSONL lines: conn_open / conn_close / request events.
// Without --file the tool reads <user-root>/logs/daemon-<daemon-id>-conn-YYYYMMDD.jsonl(.N).

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const SCHEMA = "daemon-conn-log/v1";

export function parseTimeArg(value, nowMs = Date.now()) {
  const trimmed = String(value).trim();
  const relative = /^-(\d+)([smhd])$/u.exec(trimmed);
  if (relative) {
    const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2]];
    return nowMs - Number(relative[1]) * unit;
  }
  const clock = /^(\d{1,2}):(\d{2})$/u.exec(trimmed);
  if (clock) {
    const today = new Date(nowMs);
    today.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
    return today.getTime();
  }
  const parsed = Date.parse(/^\d{4}-\d{2}-\d{2}$/u.test(trimmed) ? `${trimmed}T00:00:00` : trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

export function discoverConnLogFiles({ userRoot, daemonId }) {
  const logDir = path.join(userRoot, "logs");
  const stem = `daemon-${daemonId.replace(/[^A-Za-z0-9_.-]/gu, "-")}-conn-`;
  let names;
  try {
    names = readdirSync(logDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => new RegExp(`^${stem}\\d{8}\\.jsonl(?:\\.\\d+)?$`, "u").test(name))
    .sort()
    .map((name) => path.join(logDir, name));
}

export function loadConnLogRecords(files) {
  const records = [];
  for (const file of files) {
    let body;
    try {
      body = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of body.split("\n")) {
      if (!line.startsWith("{")) continue;
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (value?.schema !== SCHEMA) continue;
      const ts = Date.parse(value.at ?? value.atEnd ?? "");
      if (!Number.isNaN(ts)) records.push({ ...value, ts });
    }
  }
  records.sort((left, right) => left.ts - right.ts || (left.conn ?? "").localeCompare(right.conn ?? ""));
  return records;
}

// Replays every loaded record for the active-count baseline, then reports minute buckets,
// growth, dominant cadence, method latency, and connection summaries inside the window.
export function buildTimeline(records, options = {}) {
  const since = options.since ?? records[0]?.ts ?? 0;
  const until = options.until ?? records.at(-1)?.ts ?? since;
  const methodFilter = options.method ? options.method.toLowerCase() : null;
  const connFilter = options.conn ?? null;
  const top = options.top ?? 10;
  const inWindow = (record) => record.ts >= since && record.ts <= until;
  // --conn slices every event of one connection; --method narrows only request rows, so the
  // connection curve stays visible while inspecting what a method was doing.
  const connWanted = (record) => inWindow(record) && (!connFilter || record.conn === connFilter);
  const requestWanted = (record) => connWanted(record) && (!methodFilter || String(record.method ?? "").toLowerCase().includes(methodFilter));

  let active = 0;
  const minuteBuckets = new Map();
  const minuteKey = (ts) => {
    const local = new Date(ts);
    return `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")} ${String(local.getHours()).padStart(2, "0")}:${String(local.getMinutes()).padStart(2, "0")}`;
  };
  const bucketAt = (ts) => {
    const key = minuteKey(ts);
    let bucket = minuteBuckets.get(key);
    if (!bucket) { bucket = { minute: key, ts, opens: 0, closes: 0, requests: 0, activeEnd: active }; minuteBuckets.set(key, bucket); }
    return bucket;
  };
  const conns = new Map();
  const methods = new Map();
  for (const record of records) {
    if (record.event === "conn_open") { active += 1; if (inWindow(record)) conns.set(record.conn, { conn: record.conn, openedAt: record.ts, closedAt: null, requests: 0, methods: new Map(), stillOpen: true }); }
    if (record.event === "conn_close") { active -= 1; const conn = conns.get(record.conn); if (conn) { conn.closedAt = record.ts; conn.stillOpen = false; } }
    // conn_open/conn_close bucket into the curve only when the conn filter (if any) selects them;
    // activeEnd always carries the global replayed count, which stays true under any filter.
    const bucket = connWanted(record) ? bucketAt(record.ts) : null;
    if (bucket) {
      if (record.event === "conn_open") bucket.opens += 1;
      if (record.event === "conn_close") bucket.closes += 1;
      bucket.activeEnd = active;
    }
    if (record.event !== "request") continue;
    if (!requestWanted(record)) continue;
    if (bucket) bucket.requests += 1;
    const conn = conns.get(record.conn);
    if (conn) { conn.requests += 1; conn.methods.set(record.method ?? "<null>", (conn.methods.get(record.method ?? "<null>") ?? 0) + 1); }
    let stats = methods.get(record.method ?? "<null>");
    if (!stats) { stats = { method: record.method ?? "<null>", count: 0, errors: 0, durations: [] }; methods.set(stats.method, stats); }
    stats.count += 1; stats.errors += record.ok === true ? 0 : 1; stats.durations.push(record.durationMs ?? 0);
  }
  const minutes = [...minuteBuckets.values()].sort((left, right) => left.ts - right.ts);
  return {
    window: { since, until, offsetLabel: new Date(since).getTimezoneOffset() },
    counts: { records: records.length, inWindow: records.filter(inWindow).length, connsOpened: [...conns.values()].filter((conn) => inWindow({ ts: conn.openedAt })).length },
    minutes,
    growth: analyzeGrowth(minutes),
    cadence: analyzeCadence(minutes),
    methods: [...methods.values()].sort((left, right) => sum(right.durations) - sum(left.durations) || right.count - left.count).slice(0, top).map((stats) => ({ ...stats, totalMs: sum(stats.durations), p50Ms: percentile(stats.durations, 0.5), p90Ms: percentile(stats.durations, 0.9), maxMs: Math.max(...stats.durations, 0) })),
    connections: summarizeConnections(conns)
  };
}

function analyzeGrowth(minutes) {
  if (minutes.length === 0) return { startedMinute: null, peak: null, peakMinute: null, climbRatePerMinute: null };
  let start = null;
  for (let index = 0; index + 2 < minutes.length; index += 1) {
    if (minutes[index].activeEnd > minutes[index - 1]?.activeEnd && minutes[index + 1].activeEnd > minutes[index].activeEnd && minutes[index + 2].activeEnd > minutes[index + 1].activeEnd) { start = index; break; }
  }
  let peak = minutes[0];
  for (const minute of minutes) if (minute.activeEnd > peak.activeEnd) peak = minute;
  const rate = start !== null && peak.ts > minutes[start].ts ? (peak.activeEnd - minutes[start].activeEnd) / ((peak.ts - minutes[start].ts) / 60_000) : null;
  return { startedMinute: start === null ? null : minutes[start].minute, peak: peak.activeEnd, peakMinute: peak.minute, climbRatePerMinute: rate === null ? null : Math.round(rate * 10) / 10 };
}

// Heuristic only: autocorrelation of the per-minute open counts. A steady reconnect loop (a
// status probe every 60s, for example) shows up as a dominant 1-minute lag.
function analyzeCadence(minutes) {
  const opens = minutes.map((minute) => minute.opens);
  if (opens.length < 6) return { lagMinutes: null, autocorrelation: null };
  let best = { lagMinutes: null, autocorrelation: 0 };
  for (let lag = 1; lag <= 15 && lag < opens.length; lag += 1) {
    const score = pearson(opens.slice(0, opens.length - lag), opens.slice(lag));
    if (score !== null && score > best.autocorrelation) best = { lagMinutes: lag, autocorrelation: Math.round(score * 100) / 100 };
  }
  return best;
}

function summarizeConnections(conns) {
  const all = [...conns.values()];
  const stillOpen = all.filter((conn) => conn.stillOpen);
  const zeroRequest = all.filter((conn) => conn.requests === 0);
  const busiest = [...all].sort((left, right) => right.requests - left.requests).slice(0, 5)
    .map((conn) => ({ conn: conn.conn, requests: conn.requests, methods: [...conn.methods.entries()].sort((left, right) => right[1] - left[1]).slice(0, 3) }));
  return { opened: all.length, closed: all.length - stillOpen.length, stillOpen: stillOpen.length, zeroRequest: zeroRequest.length, busiest };
}

export function renderTimeline(summary) {
  const lines = [];
  const time = (ms) => new Date(ms).toLocaleString();
  lines.push(`window: ${time(summary.window.since)} .. ${time(summary.window.until)} (local; minutes below are local time)`);
  lines.push(`records: ${summary.counts.records} loaded / ${summary.counts.inWindow} in window | connections opened in window: ${summary.counts.connsOpened}`);
  const growth = summary.growth;
  lines.push(`growth: ${growth.startedMinute ? `sustained climb started ${growth.startedMinute}` : "no sustained climb detected"} | peak active ${growth.peak ?? 0} at ${growth.peakMinute ?? "-"}${growth.climbRatePerMinute !== null ? ` | climb rate ~${growth.climbRatePerMinute}/min` : ""}`);
  lines.push(`cadence: ${summary.cadence.lagMinutes && summary.cadence.autocorrelation >= 0.5 ? `conn opens repeat every ~${summary.cadence.lagMinutes} min (autocorr ${summary.cadence.autocorrelation}, heuristic)` : `no strong minute-level cadence (best autocorr ${summary.cadence.autocorrelation ?? "n/a"})`}`);
  lines.push("");
  const width = Math.max(...summary.minutes.map((minute) => minute.minute.length), 16);
  lines.push(`${"minute".padEnd(width)}  opens  closes  active  reqs  net  curve`);
  for (const minute of summary.minutes) {
    const net = minute.opens - minute.closes;
    const scale = Math.max(...summary.minutes.map((entry) => entry.activeEnd), 1);
    lines.push(`${minute.minute.padEnd(width)}  ${String(minute.opens).padStart(5)}  ${String(minute.closes).padStart(6)}  ${String(minute.activeEnd).padStart(6)}  ${String(minute.requests).padStart(4)}  ${(net >= 0 ? "+" : "") + net}  ${"#".repeat(Math.round((minute.activeEnd / scale) * 40))}`);
  }
  lines.push("");
  lines.push(`top methods by total time (of ${summary.methods.length} shown):`);
  lines.push(`  ${"method".padEnd(44)}  ${"count".padStart(7)}  ${"err".padStart(5)}  ${"p50".padStart(8)}  ${"p90".padStart(8)}  ${"max".padStart(8)}  ${"total".padStart(9)}`);
  for (const stats of summary.methods) {
    lines.push(`  ${stats.method.slice(0, 44).padEnd(44)}  ${String(stats.count).padStart(7)}  ${String(stats.errors).padStart(5)}  ${fmtMs(stats.p50Ms).padStart(8)}  ${fmtMs(stats.p90Ms).padStart(8)}  ${fmtMs(stats.maxMs).padStart(8)}  ${fmtMs(stats.totalMs).padStart(9)}`);
  }
  const conns = summary.connections;
  lines.push("");
  lines.push(`connections: ${conns.opened} opened | ${conns.closed} closed | ${conns.stillOpen} still open (leak candidates) | ${conns.zeroRequest} opened without a single request`);
  for (const conn of conns.busiest) {
    lines.push(`  ${conn.conn}: ${conn.requests} reqs (${conn.methods.map(([method, count]) => `${method} x${count}`).join(", ") || "none"})`);
  }
  return lines.join("\n");
}

function main(argv) {
  const options = { userRoot: path.join(homedir(), ".harness"), daemonId: "default", top: 10, files: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--user-root") { options.userRoot = value; index += 1; }
    else if (arg === "--daemon-id") { options.daemonId = value; index += 1; }
    else if (arg === "--since") { options.since = parseTimeArg(value); index += 1; }
    else if (arg === "--until") { options.until = parseTimeArg(value); index += 1; }
    else if (arg === "--method") { options.method = value; index += 1; }
    else if (arg === "--conn") { options.conn = value; index += 1; }
    else if (arg === "--top") { options.top = Number(value); index += 1; }
    else if (arg === "--file") { options.files.push(value); index += 1; }
    else if (arg === "--help" || arg === "-h") { console.log(usage()); return 0; }
    else { console.error(`unknown argument: ${arg}\n\n${usage()}`); return 2; }
  }
  if (options.since === null || options.until === null) { console.error("--since/--until must be ISO, YYYY-MM-DD, HH:MM, or -90m style"); return 2; }
  const files = options.files.length > 0 ? options.files : discoverConnLogFiles(options);
  if (files.length === 0) { console.error(`no conn log files under ${path.join(options.userRoot, "logs")} for daemon id "${options.daemonId}"; pass --file or check --user-root`); return 1; }
  const summary = buildTimeline(loadConnLogRecords(files), { since: options.since, until: options.until, method: options.method, conn: options.conn, top: options.top });
  console.log(renderTimeline(summary));
  return 0;
}

function usage() {
  return [
    "usage: node tools/logs/log-timeline.mjs [--user-root <dir>] [--daemon-id default] [--since <t>] [--until <t>]",
    "            [--method <substr>] [--conn c-12] [--top 10] [--file <path>]...",
    "  <t> is an ISO timestamp, a date (YYYY-MM-DD), a clock time (HH:MM, today), or relative (-90m).",
    "  Prints the minute-level connection curve, growth start/rate, reconnect cadence, top-N method",
    "  latency, and connection leak candidates from daemon conn JSONL logs."
  ].join("\n");
}

function sum(values) { return values.reduce((total, value) => total + value, 0); }

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)))];
}

function pearson(left, right) {
  if (left.length < 3) return null;
  const meanLeft = sum(left) / left.length, meanRight = sum(right) / right.length;
  let numerator = 0, leftSq = 0, rightSq = 0;
  for (let index = 0; index < left.length; index += 1) {
    const dl = left[index] - meanLeft, dr = right[index] - meanRight;
    numerator += dl * dr; leftSq += dl * dl; rightSq += dr * dr;
  }
  if (leftSq === 0 || rightSq === 0) return null;
  return numerator / Math.sqrt(leftSq * rightSq);
}

function fmtMs(value) { return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`; }

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) process.exitCode = main(process.argv.slice(2));
