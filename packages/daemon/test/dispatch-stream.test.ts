// harness-test-tier: fast
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, statSync, truncateSync, utimesSync } from "node:fs";
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
import { adoptNativeProcess } from "../src/runtime-spawn-process.ts";
import { readRuntimeSessionActivityEvidence } from "../src/dispatch-read.ts";
import { runtimeBindingForDispatch } from "../src/runtime-spawn-types.ts";
import { runtimeSessionActionPreparer } from "../src/runtime-session-action-runtime.ts";
import { getExecutableEntityAction } from "../../kernel/src/index.ts";

test("runtime dispatch persistence excludes RepoCell writer transport fields", () => {
  const actor = { principal: { personId: "runtime-owner" }, executor: null },
    source = "local" as const,
    binding = {
      actor,
      source,
      writerEpoch: 35,
      writerEpochFence: {
        schema: "harness-writer-epoch-fence/v1" as const,
        stateRoot: "/tmp/writer-state",
        repoId: "repo",
        epoch: 35,
        holderId: "daemon-old",
      },
    } as Parameters<typeof runtimeBindingForDispatch>[0] & Record<string, unknown>,
    persisted = runtimeBindingForDispatch(binding);
  assert.deepEqual(persisted, { actor, source });
});

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

test("ZCode provider writes and its live worker host form current session activity evidence", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-dispatch-zcode-activity-"));
  try {
    const dispatchId = "dispatch_555555555555555555555555",
      runtimeSessionId = "runtime_555555555555555555555555",
      target = dispatchStreamPath(rootDir, dispatchId);
    openDispatchStream(rootDir, {
      dispatchId,
      taskId: "task-zcode",
      executionId: "execution-zcode",
      runtimeSessionId,
      instanceId: "zcode-glm",
      startedAt: "2026-09-06T00:00:00.000Z",
    });
    appendRuntimeWorkerRecord(rootDir, dispatchId, {
      kind: "process_started",
      occurredAt: "2026-09-06T00:00:01.000Z",
      pid: process.pid,
    });
    const frames = [
      { type: "session.updated", payload: { type: "model_request_started" } },
      { type: "model.streaming", payload: { kind: "text_delta", delta: "working" } },
      { type: "tool.updated", payload: { kind: "result", result: { success: true } } },
      { type: "result", response: "done", usage: { modelRequestCount: 1 } },
    ];
    for (const [index, event] of frames.entries())
      appendRuntimeWorkerRecord(rootDir, dispatchId, {
        kind: "provider_event",
        occurredAt: `2026-09-06T00:00:0${String(index + 2)}.000Z`,
        event,
      });
    utimesSync(target, new Date("2026-09-06T00:00:05.000Z"), new Date("2026-09-06T00:00:05.000Z"));

    const summary = readDispatchStreamSummary(rootDir, dispatchId),
      evidence = readRuntimeSessionActivityEvidence(rootDir, dispatchId);
    assert.equal(summary?.lastObservedAt, "2026-09-06T00:00:05.000Z");
    assert.deepEqual(
      summary?.records.map((record) => record.kind),
      ["process_started"],
    );
    assert.deepEqual(evidence, { lastObservedAt: "2026-09-06T00:00:05.000Z", workerHostAlive: true });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime activity evidence is absent when no local dispatch stream exists", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-dispatch-missing-activity-"));
  try {
    assert.equal(readRuntimeSessionActivityEvidence(rootDir, "dispatch_666666666666666666666666"), undefined);
    assert.equal(readRuntimeSessionActivityEvidence(path.join(rootDir, "remote-root"), "dispatch-gui"), undefined);
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
      fast: false,
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

test("a dispatch observer delivers each pre-exit line once and stops polling at process_exit without a release", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-dispatch-observer-exit-"));
  try {
    const dispatchId = "dispatch_aaaaaaaaaaaaaaaaaaaaaaaa",
      pid = 2_147_483_647;
    openDispatchStream(rootDir, {
      dispatchId,
      taskId: null,
      executionId: null,
      runtimeSessionId: "runtime_aaaaaaaaaaaaaaaaaaaaaaaa",
      instanceId: "instance-1",
      startedAt: "2026-09-10T00:00:00.000Z",
    });
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_started", pid });
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "provider_event", event: { seq: 1 } });
    // Nothing below calls release(): settlement skips it on its early return, on a throw, and
    // across the writer-thread proxy, so the observer itself must stop at process_exit.
    const observed = adoptNativeProcess(rootDir, dispatchId, pid),
      outputs: string[] = [],
      exits: Array<number | null> = [];
    observed.onOutput((chunk) => outputs.push(chunk));
    observed.onExit((code) => exits.push(code));
    await Promise.resolve();
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "provider_event", event: { seq: 2 } });
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "provider_output_invalid", output: "not json" });
    t.mock.timers.tick(250);
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "provider_event", event: { seq: 3 } });
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_exit", exitCode: 0, signal: null });
    t.mock.timers.tick(250);
    const delivered = ['{"seq":1}\n', '{"seq":2}\n', "not json\n", '{"seq":3}\n'];
    assert.deepEqual(outputs, delivered);
    assert.deepEqual(exits, [0]);

    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "provider_event", event: { seq: "after-exit" } });
    t.mock.timers.tick(60_000);
    assert.deepEqual(outputs, delivered, "no drain tick may read the stream after process_exit");
    assert.deepEqual(exits, [0]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime cancel settles provider lines flushed while the provider is terminated", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-dispatch-cancel-tail-"));
  try {
    const dispatchId = "dispatch_bbbbbbbbbbbbbbbbbbbbbbbb",
      runtimeSessionId = "runtime_bbbbbbbbbbbbbbbbbbbbbbbb";
    openDispatchStream(rootDir, {
      dispatchId,
      taskId: null,
      executionId: null,
      runtimeSessionId,
      instanceId: "instance-1",
      startedAt: "2026-09-10T00:00:00.000Z",
    });
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_started", pid: 2_147_483_647 });
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "provider_event", event: { seq: 1 } });
    const consumed: string[] = [],
      settledAfter: number[] = [],
      active = {
        dispatchId,
        durableOutputCount: 0,
        process: {
          // Cancel holds the write queue, so these lines cannot reach settlement through the drain.
          terminateTree: async () => {
            appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "provider_event", event: { seq: 2 } });
            appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_exit", exitCode: null, signal: "SIGTERM" });
          },
        },
      };
    const receipt = await cancelRuntime(
      {
        input: { rootDir, repoId: "cancel-tail" },
        processes: new Map([[runtimeSessionId, active]]),
        consumeLine: async (runtime: typeof active, line: string) => {
          runtime.durableOutputCount += 1;
          consumed.push(line);
        },
        publishExit: async () => {
          settledAfter.push(consumed.length);
        },
        controlReceipt: () => ({ ok: true, detail: "cancelled" }),
      } as never,
      { runtimeSessionId },
      { actor: { principal: { personId: "operator" }, executor: null }, source: "local" },
    );
    assert.equal(receipt.detail, "cancelled");
    assert.deepEqual(consumed, ['{"seq":1}', '{"seq":2}']);
    assert.deepEqual(settledAfter, [2]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("fleet adoption does not probe a dispatch owned by another node", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-dispatch-node-owner-"));
  try {
    const dispatchId = "dispatch_999999999999999999999999",
      runtimeSessionId = "runtime_999999999999999999999999";
    openDispatchStream(rootDir, {
      dispatchId,
      taskId: "task-node-owner",
      executionId: "execution-node-owner",
      runtimeSessionId,
      instanceId: "instance-1",
      startedAt: "2026-08-30T00:00:00.000Z",
      dispatchOpId: "dispatch-op-node-owner",
      kindId: "codex",
      permissionMode: null,
      binding: {
        actor: { principal: { personId: "edge-worker" }, executor: null },
        source: { kind: "assignment", nodeId: "node-a", assignmentId: "assignment-a" },
      },
      cwd: rootDir,
      prompt: "node-owned adoption",
      model: "gpt-5.6-sol",
      reasoningEffort: null,
      fast: false,
    });
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_started", pid: process.pid });
    const adopted = new Map(),
      context = {
        input: {
          rootDir,
          repoId: "node-owner",
          runtimeNodeId: "node-b",
          remote: {
            readRuntimeSessions: async () => [
              { runtimeSessionId, instanceId: "instance-1", providerSessionId: null, liveness: "live", outcome: null },
            ],
          },
        },
        processes: adopted,
        reconcileFallback: () => undefined,
      };
    await adoptRuntimes(context);
    assert.equal(adopted.size, 0, "only the dispatching node may probe or settle its recorded pid");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime cancel settles a live projection whose recorded process already exited", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-runtime-cancel-exited-"));
  try {
    const dispatchId = "dispatch_cccccccccccccccccccccccc",
      runtimeSessionId = "runtime_cccccccccccccccccccccccc",
      binding = { actor: { principal: { personId: "operator" }, executor: null }, source: "local" as const };
    openDispatchStream(rootDir, {
      dispatchId,
      taskId: null,
      executionId: null,
      runtimeSessionId,
      instanceId: "instance-1",
      startedAt: "2026-09-08T00:00:00.000Z",
      dispatchOpId: "dispatch-op-exited",
      kindId: "codex",
      permissionMode: null,
      binding,
      cwd: rootDir,
      prompt: "settle exited runtime",
      model: "gpt-5.6-sol",
      reasoningEffort: null,
      fast: false,
    });
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_started", pid: 2_147_483_647 });
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_exit", exitCode: 1, signal: null });
    const settled: string[] = [],
      context = {
        input: { rootDir, repoId: "cancel-exited", now: () => "2026-09-11T00:00:00.000Z" },
        requiredRuntimeProjection: () => ({
          readRuntimeSessions: () => [
            { runtimeSessionId, instanceId: "instance-1", providerSessionId: null, liveness: "live", outcome: null },
          ],
        }),
        processes: new Map(),
        reconcileFallback: () => undefined,
        restoreDurableOutputRecords: () => undefined,
        consumeLine: async () => undefined,
        publishExit: async (active: { runtimeSessionId: string }) => {
          settled.push(active.runtimeSessionId);
          context.processes.delete(active.runtimeSessionId);
        },
        controlReceipt: () => ({ ok: true, detail: "already-exited" }),
      };
    const receipt = await cancelRuntime(context as never, { runtimeSessionId }, binding);
    assert.equal(receipt.detail, "already-exited");
    assert.deepEqual(settled, [runtimeSessionId]);
  } finally {
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

test("runtime metrics persist in the dispatch stream and read back without changing legacy streams", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-dispatch-runtime-metrics-"));
  try {
    const dispatchId = "dispatch_aaaaaaaaaaaaaaaaaaaaaaaa";
    const writer = openDispatchStream(rootDir, {
      dispatchId,
      taskId: "task-metrics",
      executionId: "execution-metrics",
      runtimeSessionId: "runtime_aaaaaaaaaaaaaaaaaaaaaaaa",
      instanceId: "instance-1",
      startedAt: "2026-09-11T00:00:00.000Z",
    });
    const raw = { input_tokens: 12, cached_input_tokens: 4, output_tokens: 7 };
    writer.appendRuntimeMetrics?.(
      {
        inputTokens: 12,
        cacheReadTokens: 4,
        outputTokens: 7,
        totalTokens: 19,
        toolCallCount: 10,
        compacted: true,
        raw,
      },
      "2026-09-11T00:01:00.000Z",
    );
    const stream = readDispatchStream(rootDir, dispatchId);
    assert.deepEqual(
      stream?.records.map((record) => record.kind),
      ["runtime_metrics"],
    );
    assert.deepEqual(stream?.records[0], {
      schema: "runtime-dispatch-stream/v1",
      kind: "runtime_metrics",
      occurredAt: "2026-09-11T00:01:00.000Z",
      inputTokens: 12,
      cacheReadTokens: 4,
      outputTokens: 7,
      totalTokens: 19,
      toolCallCount: 10,
      compacted: true,
      raw,
    });
    assert.deepEqual(stream?.runtimeMetrics, {
      kind: "runtime_metrics",
      schema: "runtime-dispatch-stream/v1",
      occurredAt: "2026-09-11T00:01:00.000Z",
      inputTokens: 12,
      cacheReadTokens: 4,
      outputTokens: 7,
      totalTokens: 19,
      toolCallCount: 10,
      compacted: true,
      raw,
    });

    const legacyId = "dispatch_bbbbbbbbbbbbbbbbbbbbbbbb";
    openDispatchStream(rootDir, {
      dispatchId: legacyId,
      taskId: "task-metrics",
      executionId: "execution-metrics",
      runtimeSessionId: "runtime_bbbbbbbbbbbbbbbbbbbbbbbb",
      instanceId: "instance-1",
      startedAt: "2026-09-11T00:00:00.000Z",
    });
    assert.equal(readDispatchStream(rootDir, legacyId)?.runtimeMetrics, null);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("portable runtime binding retains the assignment scope required by the existing action preparer", () => {
  const source = { kind: "assignment" as const, nodeId: "edge-1", assignmentId: "assignment-1" },
    binding = {
      actor: { principal: { personId: "owner" }, executor: null },
      source,
      assignmentScope: {
        repoId: "repo",
        scope: { kind: "task" as const, taskId: "task-1", executionId: "execution-1", paths: [] },
      },
    },
    prepare = runtimeSessionActionPreparer(
      () =>
        ({
          readRuntimeDispatch: () => ({
            source,
            payload: { runtimeSessionId: "runtime-1", dispatchId: "dispatch-1" },
          }),
        }) as never,
    ),
    contract = getExecutableEntityAction("runtime_session_task_bound");
  assert.ok(contract);
  const action = {
      kind: "runtime_session_task_bound",
      runtimeSessionId: "runtime-1",
      taskId: "task-1",
      executionId: "execution-1",
    },
    portable = runtimeBindingForDispatch(binding);
  assert.deepEqual(prepare(contract, action, portable), { ...action, dispatchId: "dispatch-1" });
  assert.throws(
    () => prepare(contract, { ...action, taskId: "other-task" }, portable),
    (error: unknown) => (error as { code?: string }).code === "assignment_scope_mismatch",
  );
});
