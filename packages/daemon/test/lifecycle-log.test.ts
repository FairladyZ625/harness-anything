// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DAEMON_LIFECYCLE_LOG_SCHEMA,
  daemonLifecycleLogPath,
  openDaemonLifecycleLog,
  readDaemonLifecycleGeneration,
  readDaemonLifecycleRecords,
} from "../src/lifecycle-log.ts";

function lifecycleLine(daemonId: string, entry: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({
    schema: DAEMON_LIFECYCLE_LOG_SCHEMA.id,
    at: "2026-11-04T00:00:00.000Z",
    daemonId,
    pid: process.pid,
    ...entry,
  });
}

// The daemon holds one recorder for its whole life (runtime.ts), so a recorder that only rotates on
// its first record never checks the size again: the retention policy is dead for a long-lived daemon.
test("one long-lived recorder rechecks the size cap before every append", (t) => {
  const userRoot = mkdtempSync(path.join(os.tmpdir(), "harness-lifecycle-log-")),
    daemonId = "long-lived",
    logDir = path.dirname(daemonLifecycleLogPath(userRoot, daemonId)),
    log = openDaemonLifecycleLog({
      userRoot,
      daemonId,
      maxBytes: 600,
      keptFiles: 2,
      now: () => new Date("2026-09-13T00:00:00.000Z"),
    });
  t.after(() => rmSync(userRoot, { recursive: true, force: true }));
  for (let index = 0; index < 200; index += 1)
    log.record({ event: "runtime_spawn", runtimeSessionId: `session-${index}` });

  // Rotation must have happened repeatedly on this single recorder, and keptFiles caps the generations.
  assert.deepEqual(readdirSync(logDir).sort(), [
    "daemon-long-lived-lifecycle.jsonl",
    "daemon-long-lived-lifecycle.jsonl.1",
    "daemon-long-lived-lifecycle.jsonl.2",
  ]);
  // The live file is back under the cap and the newest record survived.
  assert.ok(readFileSync(path.join(logDir, "daemon-long-lived-lifecycle.jsonl"), "utf8").length < 600 + 1024);
  const records = readDaemonLifecycleRecords(userRoot, daemonId);
  assert.equal(records.at(-1)?.runtimeSessionId, "session-199");
  assert.ok(records.length > 1, "kept generations still hold readable history");
});

test("diagnostics uses the lifecycle rotation policy in a separate schema and file", (t) => {
  const userRoot = mkdtempSync(path.join(os.tmpdir(), "ha-diag-log-"));
  t.after(() => rmSync(userRoot, { recursive: true, force: true }));
  const log = openDaemonLifecycleLog({
    userRoot,
    daemonId: "test",
    logKind: "diagnostics",
    maxBytes: 600,
    keptFiles: 2,
  });
  for (let index = 0; index < 100; index++) log.record({ event: "diagnostics", reason: "metrics", revision: index });
  const dir = path.join(userRoot, "logs"),
    names = readdirSync(dir);
  assert.deepEqual(names.sort(), [
    "daemon-test-diagnostics.jsonl",
    "daemon-test-diagnostics.jsonl.1",
    "daemon-test-diagnostics.jsonl.2",
  ]);
  const last = JSON.parse(
    readFileSync(path.join(dir, "daemon-test-diagnostics.jsonl"), "utf8").trim().split("\n").at(-1)!,
  );
  assert.equal(last.schema, "daemon-diagnostics/v1");
  assert.equal(last.revision, 99);
  assert.deepEqual(readDaemonLifecycleRecords(userRoot, "test"), []);
});

// A generation crosses a rotation boundary when the daemon rotates while it is still starting or
// running: the last process_start can sit in the newest retained generation rather than the live
// file. The reader must follow the generation back exactly one boundary and stop there.
test("the current generation is read from the tail across one rotation boundary", () => {
  const userRoot = mkdtempSync(path.join(os.tmpdir(), "harness-lifecycle-generation-")),
    daemonId = "crossed-boundary",
    logPath = daemonLifecycleLogPath(userRoot, daemonId),
    line = (entry: Readonly<Record<string, unknown>>): string => lifecycleLine(daemonId, entry);
  try {
    mkdirSync(path.dirname(logPath), { recursive: true });
    writeFileSync(`${logPath}.2`, `${line({ event: "process_start" })}\n${line({ event: "process_exit" })}\n`, "utf8");
    writeFileSync(
      `${logPath}.1`,
      `${line({ event: "runtime_spawn", runtimeSessionId: "older-generation" })}\n` +
        `${line({ event: "process_start" })}\n${line({ event: "socket_bound" })}\n`,
      "utf8",
    );
    writeFileSync(
      logPath,
      `${line({ event: "repo_attach_started", repoId: "crossed", attachIndex: 1, attachTotal: 1 })}\n` +
        `${line({ event: "identity_ready" })}\n`,
      "utf8",
    );
    assert.deepEqual(
      readDaemonLifecycleGeneration(userRoot, daemonId).map((record) => record.event),
      ["process_start", "socket_bound", "repo_attach_started", "identity_ready"],
      "the older generation in .2 is not part of the current generation",
    );
    assert.deepEqual(readDaemonLifecycleGeneration(userRoot, "absent"), []);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

// The backward scan reads fixed-size chunks, so a current generation bigger than one chunk must come
// back whole and in order without leaking into the older generation that follows it on disk.
test("a multi-chunk current generation is returned whole and in order", () => {
  const userRoot = mkdtempSync(path.join(os.tmpdir(), "harness-lifecycle-long-generation-")),
    daemonId = "long-generation",
    logPath = daemonLifecycleLogPath(userRoot, daemonId),
    current = [
      lifecycleLine(daemonId, { event: "process_start" }),
      ...Array.from({ length: 600 }, (_, index) =>
        lifecycleLine(daemonId, {
          event: "runtime_spawn",
          runtimeSessionId: `current-${index}`,
          error: "chunk padding ".repeat(8),
        }),
      ),
      lifecycleLine(daemonId, { event: "identity_ready" }),
    ];
  try {
    mkdirSync(path.dirname(logPath), { recursive: true });
    writeFileSync(logPath, `${current.join("\n")}\n`, "utf8");
    writeFileSync(
      `${logPath}.1`,
      `${lifecycleLine(daemonId, { event: "process_start" })}\n${lifecycleLine(daemonId, { event: "process_exit" })}\n`,
      "utf8",
    );
    const records = readDaemonLifecycleGeneration(userRoot, daemonId);
    assert.equal(records.length, current.length);
    assert.equal(records.at(0)?.event, "process_start");
    assert.equal(records.at(-1)?.event, "identity_ready");
    assert.deepEqual(
      records.slice(1, -1).map((record) => record.runtimeSessionId),
      Array.from({ length: 600 }, (_, index) => `current-${index}`),
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});
