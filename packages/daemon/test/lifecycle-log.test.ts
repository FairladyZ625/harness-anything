// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { daemonLifecycleLogPath, openDaemonLifecycleLog, readDaemonLifecycleRecords } from "../src/lifecycle-log.ts";

// The daemon holds one recorder for its whole life (runtime.ts), so a recorder that only rotates on
// its first record never checks the size again: the retention policy is dead for a long-lived daemon.
test("one long-lived recorder rechecks the size cap before every append", () => {
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
