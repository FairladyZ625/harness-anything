// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { daemonConnLogFileStem, DAEMON_CONN_LOG_SCHEMA, openDaemonConnLog } from "../src/conn-log.ts";
import { resultErrorDetail } from "../src/protocol/json-rpc-dispatch-support.ts";

function tempRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), "harness-conn-log-"));
}
function recordsOf(userRoot: string, daemonId = "test-daemon"): Record<string, unknown>[] {
  const dir = path.join(userRoot, "logs");
  return readdirSync(dir)
    .filter((name) => name.startsWith(daemonConnLogFileStem(daemonId)) && name.endsWith(".jsonl"))
    .flatMap((name) =>
      readFileSync(path.join(dir, name), "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    );
}
const at = (iso: string) => () => new Date(iso);

test("request failure detail records the structured diagnostic instead of prose fallback", () => {
  assert.equal(
    resultErrorDetail({
      ok: false,
      error: { code: "invalid_result" },
      diagnostic: {
        kind: "validation",
        entity: "request",
        field: "payload",
        actual: "invalid",
        expectation: "valid",
      },
    }),
    '{"kind":"validation","entity":"request","field":"payload","actual":"invalid","expectation":"valid"}',
  );
  assert.equal(resultErrorDetail({ ok: true }), null);
});

test("request failure detail records native SQLite result details", () => {
  assert.equal(
    resultErrorDetail({
      ok: false,
      error: { code: "ERR_SQLITE_ERROR", errcode: 5, errstr: "database is locked" },
    }),
    '{"errcode":5,"errstr":"database is locked"}',
  );
});

test("conn log records open/request/close with monotonic ids, active counts, and per-connection request totals", async () => {
  const userRoot = tempRoot(),
    log = openDaemonConnLog({ userRoot, daemonId: "test-daemon", now: at("2026-08-20T13:00:00Z") });
  const first = log.connectionOpened("uuid-1", "unix-socket"),
    second = log.connectionOpened("uuid-2", "unix-socket");
  assert.equal(first, "c-1");
  assert.equal(second, "c-2");
  log.request({
    conn: first,
    transport: "unix-socket",
    method: "protocol.hello",
    frameReceivedAt: Date.parse("2026-08-20T13:00:00.990Z"),
    handlerStartedAt: Date.parse("2026-08-20T13:00:01Z"),
    repliedAt: Date.parse("2026-08-20T13:00:01.003Z"),
    startedAt: Date.parse("2026-08-20T13:00:01Z"),
    dispatchDelayMs: 10,
    serviceMs: 3,
    durationMs: 3,
    ok: true,
    code: null,
    detail: null,
  });
  log.request({
    conn: first,
    transport: "unix-socket",
    method: "daemon.status",
    startedAt: Date.parse("2026-08-20T13:00:02Z"),
    durationMs: 11,
    ok: true,
    code: null,
    detail: null,
  });
  log.connectionClosed("uuid-1");
  log.request({
    conn: second,
    transport: "unix-socket",
    method: "repo.task.run",
    startedAt: Date.parse("2026-08-20T13:00:04Z"),
    durationMs: 40,
    ok: false,
    code: "repo_warming",
    detail: 'entity="task-1" field=status must be ready; actual="warming"',
  });
  log.connectionClosed("uuid-2");
  await log.settle();
  const records = recordsOf(userRoot);
  assert.deepEqual(
    records.map((record) => record.event),
    ["conn_open", "conn_open", "request", "request", "conn_close", "request", "conn_close"],
  );
  assert.equal(records[0].conn, "c-1");
  assert.equal(records[0].active, 1);
  assert.equal(records[1].conn, "c-2");
  assert.equal(records[1].active, 2);
  const hello = records[2] as {
    at: string;
    atEnd: string;
    frameReceivedAt: string;
    handlerStartedAt: string;
    repliedAt: string;
    dispatchDelayMs: number;
    serviceMs: number;
    durationMs: number;
    method: string;
    ok: boolean;
  };
  assert.equal(hello.method, "protocol.hello");
  assert.equal(hello.at, "2026-08-20T13:00:01.000Z");
  assert.equal(hello.frameReceivedAt, "2026-08-20T13:00:00.990Z");
  assert.equal(hello.handlerStartedAt, hello.at);
  assert.equal(hello.repliedAt, "2026-08-20T13:00:01.003Z");
  assert.equal(hello.atEnd, hello.repliedAt);
  assert.equal(hello.dispatchDelayMs, 10);
  assert.equal(hello.serviceMs, 3);
  assert.equal(hello.durationMs, 3);
  assert.equal(hello.ok, true);
  const close = records[4] as { conn: string; active: number; durationMs: number; requests: number };
  assert.equal(close.conn, "c-1");
  assert.equal(close.active, 1);
  assert.equal(close.requests, 2);
  assert.equal(close.durationMs, 0);
  const rejected = records[5] as { ok: boolean; code: string | null; detail: string };
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "repo_warming");
  assert.match(rejected.detail, /task-1.*field=status/u);
  const lastClose = records[6] as { conn: string; active: number };
  assert.equal(lastClose.conn, "c-2");
  assert.equal(lastClose.active, 0);
  for (const record of records) {
    assert.equal(record.schema, DAEMON_CONN_LOG_SCHEMA.id);
    assert.equal(record.daemonId, "test-daemon");
    assert.equal(typeof record.pid, "number");
    assert.equal(typeof record.at, "string");
  }
  rmSync(userRoot, { recursive: true, force: true });
});

test("conn log rolls over at a UTC day boundary and keeps both day files", async () => {
  const userRoot = tempRoot();
  let iso = "2026-08-20T23:59:58Z";
  const log = openDaemonConnLog({ userRoot, daemonId: "day", now: () => new Date(iso) });
  // The write picks its day file asynchronously, so each day's write is flushed before the clock
  // advances — the same ordering a real midnight rollover produces.
  log.connectionOpened("a", "unix-socket");
  await log.settle();
  iso = "2026-08-21T00:00:01Z";
  log.connectionOpened("b", "unix-socket");
  await log.settle();
  const names = readdirSync(path.join(userRoot, "logs")).sort();
  assert.deepEqual(names, ["daemon-day-conn-20260820.jsonl", "daemon-day-conn-20260821.jsonl"]);
  rmSync(userRoot, { recursive: true, force: true });
});

test("conn log prunes day files beyond the kept-days horizon", async () => {
  const userRoot = tempRoot(),
    dir = path.join(userRoot, "logs");
  mkdirSync(dir, { recursive: true });
  for (let day = 1; day <= 12; day += 1)
    writeFileSync(path.join(dir, `daemon-prune-conn-202608${String(day).padStart(2, "0")}.jsonl`), "\n", "utf8");
  const log = openDaemonConnLog({ userRoot, daemonId: "prune", keptDays: 7, now: at("2026-08-13T10:00:00Z") });
  log.connectionOpened("a", "unix-socket");
  await log.settle();
  const names = readdirSync(dir).sort();
  assert.deepEqual(names, [
    "daemon-prune-conn-20260806.jsonl",
    "daemon-prune-conn-20260807.jsonl",
    "daemon-prune-conn-20260808.jsonl",
    "daemon-prune-conn-20260809.jsonl",
    "daemon-prune-conn-20260810.jsonl",
    "daemon-prune-conn-20260811.jsonl",
    "daemon-prune-conn-20260812.jsonl",
    "daemon-prune-conn-20260813.jsonl",
  ]);
  rmSync(userRoot, { recursive: true, force: true });
});

test("conn log rotates the day file by size into generation suffixes", async () => {
  const userRoot = tempRoot(),
    log = openDaemonConnLog({ userRoot, daemonId: "size", maxBytes: 220, now: at("2026-08-20T10:00:00Z") });
  log.connectionOpened("a", "unix-socket");
  log.connectionOpened("b", "unix-socket");
  log.connectionOpened("c", "unix-socket");
  await log.settle();
  const names = readdirSync(path.join(userRoot, "logs")).sort();
  assert.deepEqual(names, ["daemon-size-conn-20260820.jsonl", "daemon-size-conn-20260820.jsonl.1"]);
  rmSync(userRoot, { recursive: true, force: true });
});

test("a failing conn log reports once and never throws into the request path", async () => {
  const userRoot = tempRoot(),
    blocker = path.join(userRoot, "logs");
  writeFileSync(blocker, "not a directory", "utf8");
  const failures: unknown[] = [];
  const log = openDaemonConnLog({
    userRoot,
    daemonId: "fail",
    now: at("2026-08-20T10:00:00Z"),
    onFailure: (error) => failures.push(error),
  });
  log.connectionOpened("a", "unix-socket");
  log.request({
    conn: "c-1",
    transport: "unix-socket",
    method: "protocol.hello",
    startedAt: 0,
    durationMs: 1,
    ok: true,
    code: null,
    detail: null,
  });
  await log.settle();
  log.connectionOpened("b", "unix-socket");
  await log.settle();
  assert.equal(failures.length, 1);
  rmSync(userRoot, { recursive: true, force: true });
});

test("a close for a connection this sink never saw is ignored instead of corrupting the active count", async () => {
  const userRoot = tempRoot(),
    log = openDaemonConnLog({ userRoot, daemonId: "ghost", now: at("2026-08-20T10:00:00Z") });
  log.connectionOpened("a", "unix-socket");
  log.connectionClosed("never-opened");
  log.connectionClosed("a");
  await log.settle();
  const records = recordsOf(userRoot, "ghost");
  assert.deepEqual(
    records.map((record) => record.event),
    ["conn_open", "conn_close"],
  );
  assert.equal((records.at(-1) as { active: number }).active, 0);
  rmSync(userRoot, { recursive: true, force: true });
});
