// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildTimeline, discoverConnLogFiles, loadConnLogRecords, parseTimeArg, renderTimeline } from "./log-timeline.mjs";

// Ground truth for the replay below, mirroring the F-A4858645 incident shape: a stable daemon
// with a 60s status-probe client, a runaway connector opening ~30 sockets/min from 21:40, a
// 22:07 peak, and a partial close-down at 22:14.
const base = (minute, second = 0) => new Date(2026, 7, 20, 21, minute, second).getTime();
let seq = 0;
function openEvent(minute, second) { seq += 1; return { schema: "daemon-conn-log/v1", at: new Date(base(minute, second)).toISOString(), event: "conn_open", conn: `c-${seq}`, transport: "unix-socket", active: seq }; }
function closeEvent(conn, minute, second) { return { schema: "daemon-conn-log/v1", at: new Date(base(minute, second)).toISOString(), event: "conn_close", conn, active: 0, durationMs: 500, requests: 1 }; }
function requestEvent(conn, minute, second, method, durationMs, ok = true, code = null) { return { schema: "daemon-conn-log/v1", at: new Date(base(minute, second)).toISOString(), event: "request", conn, transport: "unix-socket", method, atEnd: new Date(base(minute, second) + durationMs).toISOString(), durationMs, ok, code }; }

function incidentReplay() {
  seq = 0;
  const records = [];
  // 21:18-21:19: five short-lived watch-session connections.
  for (let index = 0; index < 5; index += 1) { const opened = openEvent(18, index); records.push(opened, requestEvent(opened.conn, 18, index + 1, "protocol.hello", 2), closeEvent(opened.conn, 18, index + 2)); }
  // 21:19 onward: one connection per minute from a 60s status probe.
  for (let minute = 19; minute < 74; minute += 1) { const probe = openEvent(minute, 5); records.push(probe, requestEvent(probe.conn, minute, 6, "protocol.hello", 3), requestEvent(probe.conn, minute, 6, "daemon.status", 1_200), closeEvent(probe.conn, minute, 9)); }
  // 21:40-22:06: a runaway connector leaks 30 sockets per minute.
  for (let minute = 40; minute < 67; minute += 1) for (let index = 0; index < 30; index += 1) records.push(openEvent(minute, index * 2));
  // 22:14: the GUI stops and 33 of the leaked sockets drain.
  for (let index = 0; index < 33; index += 1) records.push(closeEvent(`c-${seq - index}`, 74, index));
  return records;
}

test("parseTimeArg accepts ISO stamps, bare dates, clock times, and relative windows", () => {
  assert.equal(parseTimeArg("2026-08-20T12:00:00Z"), Date.parse("2026-08-20T12:00:00Z"));
  assert.equal(parseTimeArg("2026-08-20"), Date.parse("2026-08-20T00:00:00"));
  const now = Date.parse("2026-08-20T15:30:00Z");
  assert.equal(parseTimeArg("-90m", now), now - 90 * 60_000);
  assert.equal(parseTimeArg("-2h", now), now - 2 * 3_600_000);
  assert.equal(parseTimeArg("14:05", now), new Date(2026, 7, 20, 14, 5).getTime());
  assert.equal(parseTimeArg("not a time", now), null);
});

test("the timeline recovers growth start, climb rate, cadence, and leak counts from a replayed flood", () => {
  const records = incidentReplay();
  const summary = buildTimeline(records.map((record) => ({ ...record, ts: Date.parse(record.at) })), { since: base(0), until: base(80) });
  assert.equal(summary.growth.startedMinute, "2026-08-20 21:40");
  assert.equal(summary.growth.peakMinute, "2026-08-20 22:06");
  assert.equal(summary.growth.peak, 27 * 30 - 33 + 33, "peak active is every leaked socket before the drain");
  assert.ok(Math.abs(summary.growth.climbRatePerMinute - 30) < 1, `climb rate ~30/min, got ${summary.growth.climbRatePerMinute}`);
  assert.equal(summary.cadence.lagMinutes, 1);
  assert.ok(summary.cadence.autocorrelation >= 0.5, `dominant cadence is ~1min, autocorr ${summary.cadence.autocorrelation}`);
  const peakMinute = summary.minutes.find((minute) => minute.minute === "2026-08-20 22:06");
  assert.equal(peakMinute.opens, 30 + 1, "leak opens plus the 60s probe in the peak minute");
  const drainedMinute = summary.minutes.find((minute) => minute.minute === "2026-08-20 22:14");
  assert.equal(drainedMinute.closes, 33, "the 22:14 GUI stop drains 33 leaked sockets; the probe loop has ended by then");
  const hello = summary.methods.find((stats) => stats.method === "protocol.hello");
  const status = summary.methods.find((stats) => stats.method === "daemon.status");
  assert.equal(hello.count, 5 + 55); assert.equal(hello.p99Ms, 3);
  assert.equal(status.count, 55); assert.equal(status.p50Ms, 1_200); assert.equal(status.p99Ms, 1_200);
  assert.equal(summary.methods[0].method, "daemon.status", "the slow probe method dominates total time");
  assert.equal(summary.connections.stillOpen, 27 * 30 - 33);
  assert.equal(summary.connections.zeroRequest, 27 * 30, "every leaked socket — drained or not — opened without a single request");
  const busiest = summary.connections.busiest[0];
  assert.equal(busiest.requests, 2); assert.deepEqual(busiest.methods, [["protocol.hello", 1], ["daemon.status", 1]]);
});

test("method and connection filters slice the timeline without losing the global active baseline", () => {
  const records = incidentReplay().map((record) => ({ ...record, ts: Date.parse(record.at) }));
  const byMethod = buildTimeline(records, { since: base(0), until: base(80), method: "daemon.status" });
  assert.equal(byMethod.methods.length, 1);
  const probeMinute = byMethod.minutes.find((minute) => minute.minute === "2026-08-20 21:30");
  assert.equal(probeMinute.requests, 1);
  assert.equal(probeMinute.opens, 1, "the 60s probe still opens one socket that minute");
  const byConn = buildTimeline(records, { since: base(0), until: base(80), conn: "c-1" });
  assert.deepEqual(byConn.methods.map((stats) => stats.method), ["protocol.hello"]);
  assert.equal(byConn.minutes.length, 1);
});

test("file discovery and JSONL loading skip foreign files and malformed lines", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "log-timeline-"));
  const logDir = path.join(userRoot, "logs");
  mkdirSync(logDir, { recursive: true });
  const line = (at, event, conn) => `${JSON.stringify({ schema: "daemon-conn-log/v1", at, event, conn })}\n`;
  writeFileSync(path.join(logDir, "daemon-default-conn-20260820.jsonl"), `not json\n${line("2026-08-20T10:00:00.000Z", "conn_open", "c-1")}${JSON.stringify({ schema: "other/v1" })}\n`);
  writeFileSync(path.join(logDir, "daemon-default-conn-20260820.jsonl.1"), line("2026-08-20T09:00:00.000Z", "conn_close", "c-1"));
  writeFileSync(path.join(logDir, "daemon-default.log"), "a lifecycle log, not conn traffic\n");
  writeFileSync(path.join(logDir, "daemon-other-conn-20260820.jsonl"), line("2026-08-20T11:00:00.000Z", "conn_open", "c-9"));
  try {
    assert.deepEqual(discoverConnLogFiles({ userRoot, daemonId: "default" }), [
      path.join(logDir, "daemon-default-conn-20260820.jsonl"),
      path.join(logDir, "daemon-default-conn-20260820.jsonl.1")
    ]);
    const records = loadConnLogRecords(discoverConnLogFiles({ userRoot, daemonId: "default" }));
    assert.deepEqual(records.map((record) => [record.event, record.conn]), [["conn_close", "c-1"], ["conn_open", "c-1"]], "generation files load oldest-first and malformed lines drop");
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("renderTimeline prints the growth, cadence, curve, methods, and leak summary a responder needs", () => {
  const records = incidentReplay().map((record) => ({ ...record, ts: Date.parse(record.at) }));
  const text = renderTimeline(buildTimeline(records, { since: base(0), until: base(80) }));
  assert.match(text, /growth: sustained climb started 2026-08-20 21:40 \| peak active \d+ at 2026-08-20 22:06 \| climb rate ~30\/min/u);
  assert.match(text, /cadence: conn opens repeat every ~1 min/u);
  assert.match(text, /2026-08-20 21:40.* 30 /u);
  assert.match(text, /daemon\.status .*55 .*1\.2s/u);
  assert.match(text, /still open \(leak candidates\)/u);
});
