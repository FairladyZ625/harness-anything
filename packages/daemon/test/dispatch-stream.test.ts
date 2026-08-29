// harness-test-tier: fast
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, statSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendRuntimeWorkerRecord,
  dispatchLiveIndexPath,
  dispatchStreamPath,
  openDispatchStream,
  readDispatchLiveIndex,
  readDispatchStream,
  readDispatchStreamSummary,
} from "../src/dispatch-stream.ts";
import { adoptRuntimes } from "../src/runtime-spawn-adoption.ts";
import { cancelRuntime } from "../src/runtime-spawn-control.ts";

test("the live index rebuilds exactly from dispatch stream headers", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-dispatch-live-index-"));
  try {
    for (const suffix of ["111111111111111111111111", "222222222222222222222222"] as const) {
      const dispatchId = `dispatch_${suffix}`;
      openDispatchStream(rootDir, {
        dispatchId,
        taskId: "task-1",
        executionId: "execution-1",
        runtimeSessionId: `runtime_${suffix}`,
        instanceId: "instance-1",
        startedAt: "2026-08-24T00:00:00.000Z",
      });
      appendRuntimeWorkerRecord(rootDir, dispatchId, {
        kind: "provider_event",
        event: { text: "tail records are not needed to rebuild the header index" },
      });
    }
    const before = readDispatchLiveIndex(rootDir, ["task-1"]);
    rmSync(dispatchLiveIndexPath(rootDir, "task-1"));
    const rebuilt = readDispatchLiveIndex(rootDir, ["task-1"]);
    assert.deepEqual(rebuilt, before);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("process lifecycle observations remain in the append-only dispatch stream", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-dispatch-process-stream-"));
  try {
    const dispatchId = "dispatch_333333333333333333333333";
    openDispatchStream(rootDir, {
      dispatchId,
      taskId: "task-2",
      executionId: "execution-2",
      runtimeSessionId: "runtime_333333333333333333333333",
      instanceId: "instance-1",
      startedAt: "2026-08-24T00:00:00.000Z",
    });
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_started", pid: 4321 });
    appendRuntimeWorkerRecord(rootDir, dispatchId, {
      kind: "process_exit",
      exitCode: null,
      signal: "SIGKILL",
      occurredAt: "2026-08-24T00:01:00.000Z",
    });
    const stream = readDispatchStream(rootDir, dispatchId);
    assert.deepEqual(stream?.process, { pid: 4321, exitCode: null, signal: "SIGKILL", exited: true });
    assert.deepEqual(
      stream?.records.map((record) => record.kind),
      ["process_started", "process_exit"],
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("dispatch summaries skip provider bodies and refresh when lifecycle records append", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-dispatch-summary-"));
  try {
    const dispatchId = "dispatch_444444444444444444444444";
    openDispatchStream(rootDir, {
      dispatchId,
      taskId: "task-3",
      executionId: "execution-3",
      runtimeSessionId: "runtime_444444444444444444444444",
      instanceId: "instance-1",
      startedAt: "2026-08-24T00:00:00.000Z",
      prompt: "p".repeat(64 * 1024),
    });
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_started", pid: 9876 });
    appendRuntimeWorkerRecord(rootDir, dispatchId, {
      kind: "provider_event",
      event: { text: "x".repeat(512 * 1024) },
    });
    const running = readDispatchStreamSummary(rootDir, dispatchId);
    assert.deepEqual(running?.process, { pid: 9876, exitCode: null, signal: null, exited: false });
    assert.deepEqual(
      running?.records.map((record) => record.kind),
      ["process_started"],
    );
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_exit", exitCode: 0, signal: null });
    const exited = readDispatchStreamSummary(rootDir, dispatchId);
    assert.deepEqual(exited?.process, { pid: 9876, exitCode: 0, signal: null, exited: true });
    assert.deepEqual(
      exited?.records.map((record) => record.kind),
      ["process_started", "process_exit"],
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("adoption skips a stream above Node's string limit while runtime cancel still stops the process", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-dispatch-oversized-read-"));
  const warning = console.warn,
    warnings: string[] = [];
  console.warn = (value: unknown) => warnings.push(String(value));
  try {
    const dispatchId = "dispatch_777777777777777777777777",
      target = dispatchStreamPath(rootDir, dispatchId);
    openDispatchStream(rootDir, {
      dispatchId,
      taskId: "task-oversized",
      executionId: "execution-oversized",
      runtimeSessionId: "runtime_777777777777777777777777",
      instanceId: "instance-1",
      startedAt: "2026-08-29T00:00:00.000Z",
      dispatchOpId: "dispatch-op-oversized",
      kindId: "codex",
      permissionMode: null,
      binding: {
        actor: { principal: { personId: "operator" }, executor: null },
        source: "local",
      },
      cwd: rootDir,
      prompt: "oversized adoption",
      model: "gpt-5.6-sol",
      reasoningEffort: null,
    });
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_started", pid: process.pid });
    truncateSync(target, 600 * 1024 * 1024);

    const adopted = new Map(),
      context = {
        input: { rootDir, repoId: "oversized-read" },
        requiredRuntimeProjection: () => ({
          readRuntimeSessions: () => [
            {
              runtimeSessionId: "runtime_777777777777777777777777",
              liveness: "live",
              outcome: null,
            },
          ],
        }),
        processes: adopted,
      };
    await adoptRuntimes(context);
    assert.equal(adopted.size, 1);
    assert.equal(readDispatchStream(rootDir, dispatchId), null);
    assert.equal(statSync(target).size, 600 * 1024 * 1024);
    assert.match(warnings.join("\n"), /skipping full read/u);
    let terminated = false,
      published = false;
    const runtimeSessionId = "runtime_777777777777777777777777",
      active = adopted.get(runtimeSessionId);
    assert.ok(active);
    active.process.terminateTree = async () => {
      terminated = true;
    };
    const receipt = await cancelRuntime(
      {
        ...context,
        publishExit: async () => {
          published = true;
        },
        controlReceipt: () => ({ ok: true, detail: "cancelled" }),
      },
      { runtimeSessionId },
      { actor: { principal: { personId: "operator" }, executor: null }, source: "local" },
    );
    assert.equal(receipt.detail, "cancelled");
    assert.equal(terminated, true);
    assert.equal(published, true);
  } finally {
    console.warn = warning;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("the dispatch fuse drops unbounded output but preserves terminal records", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-dispatch-write-fuse-"));
  const warning = console.warn,
    warnings: string[] = [];
  console.warn = (value: unknown) => warnings.push(String(value));
  try {
    const dispatchId = "dispatch_888888888888888888888888",
      target = dispatchStreamPath(rootDir, dispatchId);
    openDispatchStream(rootDir, {
      dispatchId,
      taskId: "task-fused",
      executionId: "execution-fused",
      runtimeSessionId: "runtime_888888888888888888888888",
      instanceId: "instance-1",
      startedAt: "2026-08-29T00:00:00.000Z",
    });
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_started", pid: 8765 });
    truncateSync(target, 500 * 1024 * 1024 - 1);
    appendFileSync(target, "\n");
    const cappedSize = statSync(target).size;

    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "provider_event", event: { text: "dropped" } });
    assert.equal(statSync(target).size, cappedSize);
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_exit", exitCode: 1, signal: null });
    assert.ok(statSync(target).size > cappedSize);
    assert.deepEqual(readDispatchStreamSummary(rootDir, dispatchId)?.process, {
      pid: 8765,
      exitCode: 1,
      signal: null,
      exited: true,
    });
    assert.match(warnings.join("\n"), /dropping unbounded output/u);
  } finally {
    console.warn = warning;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("delegation provenance fields survive a header roundtrip and stay optional for history", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-dispatch-parent-session-"));
  try {
    const delegated = "dispatch_444444444444444444444444",
      leaderOnly = "dispatch_555555555555555555555555",
      parentRuntimeSessionId = "runtime_0123456789abcdef01234567";
    openDispatchStream(rootDir, {
      dispatchId: delegated,
      taskId: "task-3",
      executionId: "execution-3",
      runtimeSessionId: "runtime_444444444444444444444444",
      instanceId: "instance-1",
      startedAt: "2026-08-28T00:00:00.000Z",
      delegatedByAgentId: "parent-leader",
      delegatedByAgentName: "Parent Leader",
      squadId: "parent-squad",
      parentRuntimeSessionId,
    });
    openDispatchStream(rootDir, {
      dispatchId: leaderOnly,
      taskId: "task-3",
      executionId: "execution-3",
      runtimeSessionId: "runtime_555555555555555555555555",
      instanceId: "instance-1",
      startedAt: "2026-08-28T00:00:00.000Z",
      squadId: "parent-squad",
      parentRuntimeSessionId,
    });
    const edge = readDispatchStream(rootDir, delegated),
      leader = readDispatchStream(rootDir, leaderOnly);
    assert.equal(edge?.header.parentRuntimeSessionId, parentRuntimeSessionId);
    assert.equal(edge?.header.delegatedByAgentId, "parent-leader");
    assert.equal(edge?.header.squadId, "parent-squad");
    assert.equal(leader?.header.parentRuntimeSessionId, parentRuntimeSessionId);
    assert.equal(leader?.header.squadId, "parent-squad");
    assert.equal(Object.hasOwn(leader?.header ?? {}, "delegatedByAgentId"), false);
    const historical = "dispatch_666666666666666666666666";
    openDispatchStream(rootDir, {
      dispatchId: historical,
      taskId: "task-3",
      executionId: "execution-3",
      runtimeSessionId: "runtime_666666666666666666666666",
      instanceId: "instance-1",
      startedAt: "2026-08-19T00:00:00.000Z",
    });
    const legacy = readDispatchStream(rootDir, historical);
    assert.ok(legacy, "a header predating the parent-session edge still reads");
    assert.equal(Object.hasOwn(legacy.header, "parentRuntimeSessionId"), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
