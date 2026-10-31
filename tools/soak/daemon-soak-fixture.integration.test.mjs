// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openSqliteEventStore, resolveActiveGeneration } from "../../packages/storage/src/index.ts";
import { readDispatchStreamSummary } from "../../packages/daemon/src/dispatch-stream.ts";
import { createSoakEvents, initializeFixture } from "./daemon-soak.mjs";

// This builds a real Git repository and runs the SQLite generation conversion twice, so it belongs
// to the integration tier rather than beside the pure soak assessments.
test("scale fixture converts to an attachable generation-3 ledger instead of unconverted legacy history", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-soak-fixture-")),
    repoId = "nightly-soak",
    rootDir = path.join(parent, "repo"),
    events = createSoakEvents({ taskCount: 3, eventCount: 12 });
  try {
    const fixture = initializeFixture({
      rootDir,
      legacyRoot: path.join(parent, "legacy"),
      backupDir: path.join(parent, "backup"),
      userRoot: path.join(parent, "user"),
      repoId,
      events,
    });
    assert.deepEqual(fixture, { generation: 3, revision: events.length });
    // The product refuses to attach a repository whose conversion stopped at an older
    // generation; this assertion is the failure the fixture used to hit in the nightly lane.
    assert.equal(resolveActiveGeneration({ rootInput: rootDir }), 3);
    const store = openSqliteEventStore({ repoId, rootInput: rootDir, readOnly: true });
    try {
      assert.equal(store.revision(), events.length);
    } finally {
      store.close();
    }
    const dispatch = events.find(({ type }) => type === "runtime_dispatch_requested"),
      summary = readDispatchStreamSummary(rootDir, dispatch.payload.dispatchId);
    // Attach admission derives liveness from this stream; without the live witness the
    // fault-control stream is refused as unsupported and the reconnect invariant never runs.
    assert.equal(summary.process.exited, false);
    assert.equal(summary.process.pid, process.pid);
    assert.equal(summary.header.runtimeSessionId, "runtime-session-soak");
  } finally {
    rmSync(parent, { recursive: true, force: true, maxRetries: 5 });
  }
});
