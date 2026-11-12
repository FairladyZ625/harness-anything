// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { appendRuntimeWorkerRecord, openDispatchStream } from "../src/dispatch-stream.ts";
import { readAgentRuntimeTokenUsage, readAgentRuntimeTokenUsageDetail } from "../src/agent-runtime-token-usage.ts";
import { lifecycleReadForSync } from "./dispatch-lifecycle-read.fixtures.ts";

test("usage outcomes and pending receipts follow canonical lifecycle despite contradictory local evidence", (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-usage-canonical-")),
    dispatchId = "dispatch_abcdefabcdefabcdefabcdef",
    runtimeSessionId = "runtime-usage",
    now = "2026-11-12T00:00:00.000Z";
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  openDispatchStream(rootDir, {
    dispatchId,
    runtimeSessionId,
    instanceId: "worker",
    taskId: null,
    executionId: null,
    startedAt: now,
    agentId: "worker",
  });
  appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_started", pid: 2147483647 });
  let pending = false,
    settled = true;
  const projection = {
      readRuntimeDispatchPage: () => ({ rows: [], nextCursor: null, done: true }),
      readDispatchLifecycle: (query: Parameters<ReturnType<typeof lifecycleReadForSync>>[0]) =>
        pending
          ? { status: "pending" as const, watermark: 2, sourceRevision: 3 }
          : lifecycleReadForSync([
              {
                dispatchId,
                runtimeSessionId,
                attemptSettled: settled,
                process: settled ? "exited" : "alive",
                outcome: settled ? "succeeded" : null,
              },
            ])(query),
    },
    input = {
      rootDir,
      now,
      range: "today" as const,
      projection,
      entityLabel: () => null,
      cut: { status: "ready" as const, watermark: 3, sourceRevision: 3 },
    },
    detail = () => readAgentRuntimeTokenUsageDetail({ ...input, member: { kind: "agent", agentId: "worker" } }),
    aggregate = () => readAgentRuntimeTokenUsage({ ...input, taskOf: () => undefined });
  assert.equal(detail().sessions[0]?.outcome, "succeeded");
  assert.equal(detail().sessions[0]?.usage, "unavailable");
  assert.equal(aggregate().outcomes.find((row) => row.outcome === "succeeded")?.sessionCount, 1);
  settled = false;
  appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_exit", exitCode: 1, signal: null });
  assert.equal(detail().sessions[0]?.outcome, "running");
  assert.equal(detail().sessions[0]?.usage, "pending");
  assert.equal(aggregate().outcomes.find((row) => row.outcome === "running")?.sessionCount, 1);
  pending = true;
  assert.equal(detail().status, "pending");
  assert.equal(detail().sessions[0]?.outcome, "unknown");
  assert.equal(aggregate().status, "pending");
});
