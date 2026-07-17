// harness-test-tier: contract
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DaemonLogEntryV1 } from "../../application/src/index.ts";
import { makeDaemonLogFileStore } from "../src/daemon/daemon-log-file-store.ts";

test("daemon log file store rotates segments, enforces retention, and counts malformed JSONL", async () => {
  const userRoot = mkdtempSync(path.join(os.tmpdir(), "ha-daemon-log-store-"));
  const logRoot = path.join(userRoot, "logs", "harness-anything");
  try {
    const store = makeDaemonLogFileStore({
      userRoot,
      maxSegmentBytes: 1,
      retentionDays: 14,
      maxSegments: 2
    });
    await store.append(entry(0, "2026-06-01T00:00:00.000Z"));
    await store.append(entry(1, "2026-07-16T00:00:00.000Z"));
    await store.append(entry(2, "2026-07-16T00:00:01.000Z"));

    assert.deepEqual(readdirSync(logRoot).sort(), ["2026-07-16.1.ndjson", "2026-07-16.ndjson"]);
    appendFileSync(path.join(logRoot, "2026-07-16.1.ndjson"), "{invalid-json}\n", "utf8");
    const read = await store.read();
    assert.equal(read.records.length, 2);
    assert.equal(read.droppedCount, 1);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

function entry(sequence: number, timestamp: string): DaemonLogEntryV1 {
  return {
    schema: "daemon-log-entry/v1",
    timestamp,
    sequence,
    level: "info",
    source: "daemon",
    component: "protocol",
    event: "rotation",
    message: "entry",
    repoId: "canonical",
    redaction: { policy: "runtime-log-redaction/v1", fieldsRemoved: [], truncated: false }
  };
}
