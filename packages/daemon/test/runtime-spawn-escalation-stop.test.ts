// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { publishExit, runtimeProcessTreeStopped } from "../src/runtime-spawn-settlement.ts";
import type { RuntimeSpawnerContext } from "../src/runtime-spawn-context.ts";
import type { ActiveRuntime } from "../src/runtime-spawn-types.ts";
import { active } from "./runtime-spawn-settlement.fixtures.ts";
import { dispatchLifecycleReadOf, lifecycleEvent } from "./dispatch-lifecycle-read.fixtures.ts";

import { statSync, truncateSync } from "node:fs";
import { adoptRuntimes } from "../src/runtime-spawn-adoption.ts";
import { cancelRuntime } from "../src/runtime-spawn-control.ts";
import {
  appendRuntimeWorkerRecord,
  dispatchStreamPath,
  openDispatchStream,
  readDispatchStream,
} from "../src/dispatch-stream.ts";
import { lifecycleReadFor } from "./dispatch-lifecycle-read.fixtures.ts";
import { fixtureRuntimeProcess, runtimeProcessFixture } from "./fixtures/runtime-process.ts";
import {
  publishExit as publishSettlementExit,
  tasklessSettlementRuntime,
} from "./runtime-spawn-settlement.fixtures.ts";

// Keep controller tests on the real terminal publisher and accepted aggregate, so cancellation
// assertions cover completed stop/output/terminal behavior across the ownership boundary.
function withCancellationSettlement(value: unknown, onTerminal: () => void): RuntimeSpawnerContext {
  const input = value as RuntimeSpawnerContext;
  const context = {
    ...input,
    input: {
      ...input.input,
      now: () => "2026-11-11T00:00:00.000Z",
      stream: { publish: () => ({}) },
    },
    exiting: new Set<string>(),
    runtimeSpawnError: (code: string, message: string) => Object.assign(new Error(message), { code }),
    runtimeResultText: () => "worker stopped",
    markProtocolError: () => undefined,
    publishRuntimeEvent: async (type: string) => {
      if (type === "runtime_session_outcome_observed") onTerminal();
      return {};
    },
    settleFallback: async () => undefined,
    controlReceipt: () => ({ ok: true, detail: "cancelled" }),
    publishExit: (runtime: ActiveRuntime, code: number | null) =>
      publishSettlementExit(
        {
          ...context,
          input: { ...context.input, remote: { archive: async () => ({ outcome: "applied" }) } },
        } as unknown as RuntimeSpawnerContext,
        runtime,
        code,
      ),
  } as unknown as RuntimeSpawnerContext;
  return context;
}

test("an unproven self PID rejects settlement without releasing its recovery handle", async () => {
  let released = false;
  const runtime = active({
      process: {
        pid: process.pid,
        onOutput: () => undefined,
        onErrorOutput: () => undefined,
        onExit: () => undefined,
        terminate: () => assert.fail("settlement must never stop its own process"),
        release: () => {
          released = true;
        },
      },
    }),
    processes = new Map([[runtime.runtimeSessionId, runtime]]),
    exiting = new Set<string>(),
    contextValue = {
      input: { rootDir: "/unused" },
      processes,
      exiting,
      runtimeSpawnError: (code: string, message: string) => Object.assign(new Error(message), { code }),
      publishRuntimeEvent: () => assert.fail("an unproven stop cannot publish a terminal event"),
    } as unknown as RuntimeSpawnerContext;
  await Promise.all([
    assert.rejects(publishExit(contextValue, runtime, 0), { code: "runtime_process_group_unproven" }),
    assert.rejects(publishExit(contextValue, runtime, 0), { code: "runtime_process_group_unproven" }),
  ]);
  assert.equal(runtime.exitSettlement, undefined, "a later recovery may retry settlement");
  assert.equal(exiting.size, 0);
  assert.equal(processes.get(runtime.runtimeSessionId), runtime);
  assert.equal(released, false);
});

for (const stopProofCode of ["runtime_process_group_unproven", "runtime_lease_release_failed"] as const)
  test(`escalation settlement retries ${stopProofCode} after full tree cleanup`, async (context) => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-escalation-tree-stop-")),
      packageRoot = path.join(rootDir, "harness", "tasks", "task-owner"),
      worker = fixtureRuntimeProcess(context);
    context.after(() => rmSync(rootDir, { recursive: true, force: true }));
    mkdirSync(path.join(packageRoot, "artifacts", "rulings"), { recursive: true });
    writeFileSync(
      path.join(packageRoot, "artifacts", "rulings", "dispatch_0123456789abcdef01234567.md"),
      "---\nruling: awaiting\nquestion: May this worker change the shared transport?\noptions:\n  - Keep the boundary\n---\n",
    );

    let finishTreeCleanup!: () => void,
      treeCleanupStarted = false,
      treeCleaned = false,
      released = false,
      stopProofAvailable = false,
      settlementAttempts = 0;
    const treeCleanup = new Promise<void>((resolve) => {
        finishTreeCleanup = () => {
          treeCleaned = true;
          resolve();
        };
      }),
      runtime = active({
        process: {
          pid: worker.pid,
          onOutput: () => undefined,
          onErrorOutput: () => undefined,
          onExit: () => undefined,
          terminate: worker.terminate,
          terminateTree: async () => {
            treeCleanupStarted = true;
            await treeCleanup;
            await worker.terminateTree();
          },
          release: () => {
            released = true;
          },
        },
        dispatchId: "dispatch_0123456789abcdef01234567",
        runtimeSessionId: "runtime-escalation-tree-stop",
        cancelRequested: true,
        cancelOpId: "runtime-cancel:escalation",
        binding: {
          actor: {
            principal: { kind: "human", id: "operator" },
            executor: { kind: "agent", id: "runtime-session:runtime-escalation-tree-stop" },
          },
          source: "local",
        },
        task: { taskId: "task-owner", executionId: "execution-owner", leaseVersion: 1 },
        cwd: rootDir,
        stream: {
          ref: "runtime-stream:dispatch_0123456789abcdef01234567",
          appendAttemptOutcome: () => undefined,
          appendTerminalOutcome: () => undefined,
        } as never,
      }) as ActiveRuntime,
      published: string[] = [],
      lifecycleOptions = {
        instanceId: runtime.instanceId,
        source: "local" as const,
        dispatchId: runtime.dispatchId,
        taskId: runtime.task!.taskId,
        executionId: runtime.task!.executionId,
      },
      lifecycleEvents = [
        lifecycleEvent("R", runtime.runtimeSessionId, lifecycleOptions),
        lifecycleEvent("S", runtime.runtimeSessionId, lifecycleOptions),
      ],
      readLifecycle = dispatchLifecycleReadOf(() => lifecycleEvents),
      outcomes: unknown[] = [],
      contextValue = {
        exiting: new Set<string>(),
        processes: new Map([[runtime.runtimeSessionId, runtime]]),
        input: {
          repoId: "canonical",
          rootDir,
          now: () => "2026-11-02T00:00:00.000Z",
          stream: { publish: () => ({}) },
          remote: {
            archive: async () => ({ outcome: "applied" }),
            taskContext: async () => ({ packageRoot }),
            readDispatchLifecycle: async (query: Parameters<typeof readLifecycle>[0]) => readLifecycle(query),
          },
        },
        resultMediaType: "text/markdown",
        runtimeSpawnError: (code: string, message: string) => Object.assign(new Error(message), { code }),
        runtimeResultText: () => "worker requested an owner ruling",
        markProtocolError: () => undefined,
        publishRuntimeEvent: async (type: string, payload: unknown) => {
          if (type === "runtime_session_outcome_observed") {
            assert.equal(treeCleaned, true, "settlement must wait for descendants to stop");
            settlementAttempts += 1;
            if (!stopProofAvailable)
              throw Object.assign(new Error("center refused settlement"), { code: stopProofCode });
            outcomes.push(payload);
            lifecycleEvents.push(lifecycleEvent("O", runtime.runtimeSessionId, lifecycleOptions));
          }
          if (type === "runtime_session_exited")
            lifecycleEvents.push(lifecycleEvent("X", runtime.runtimeSessionId, lifecycleOptions));
          published.push(type);
          return {};
        },
        settleFallback: async () => undefined,
      } as unknown as RuntimeSpawnerContext,
      settlement = publishExit(contextValue, runtime, null);

    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(treeCleanupStarted, true, "settlement must join complete process-tree cleanup");
      assert.equal(outcomes.length, 0, "task lease release must wait for process-tree cleanup");
      assert.deepEqual(published, [], "a terminal dispatch outcome must not be published early");
      assert.equal(
        contextValue.processes.has(runtime.runtimeSessionId),
        true,
        "the runtime stays retryable before stop proof",
      );
      assert.equal(released, false, "the process owner stays available until stop proof");

      finishTreeCleanup();
      await assert.rejects(
        settlement,
        (error: unknown) => error instanceof Error && "code" in error && error.code === stopProofCode,
      );
      assert.equal(settlementAttempts, 1);
      assert.equal(outcomes.length, 0, "an unavailable stop proof must not publish unknown or retire the runtime");
      assert.deepEqual(published, ["runtime_session_exited"]);
      assert.equal(
        contextValue.processes.has(runtime.runtimeSessionId),
        false,
        "a stopped owner can be released after proof",
      );
      assert.equal(released, true);

      stopProofAvailable = true;
      await publishExit(contextValue, runtime, null);

      assert.equal(settlementAttempts, 2);
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes.length === 1, true);
      assert.equal(contextValue.processes.has(runtime.runtimeSessionId), false);
      assert.equal(released, true);
      assert.deepEqual(published, [
        "runtime_session_exited",
        "runtime_session_exited",
        "runtime_session_outcome_observed",
      ]);
    } finally {
      finishTreeCleanup();
      await settlement.catch(() => undefined);
    }
  });

test("adoption skips a stream above Node's string limit while runtime cancel still stops the process", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-dispatch-oversized-read-"));
  const warning = console.warn,
    warnings: string[] = [];
  console.warn = (value: unknown) => warnings.push(String(value));
  try {
    const runtime = runtimeProcessFixture(t),
      dispatchId = "dispatch_777777777777777777777777",
      target = dispatchStreamPath(rootDir, dispatchId);
    openDispatchStream(rootDir, {
      dispatchId,
      taskId: "task-oversized",
      executionId: "execution-oversized",
      reviewTarget: {
        kind: "decision",
        decisionId: "dec_PERSISTED_TARGET",
        digest: `sha256:${"a".repeat(64)}`,
      },
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
      prompt: "prompt intentionally contains no review target",
      model: "gpt-5.6-sol",
      reasoningEffort: null,
      fast: false,
    });
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_started", pid: runtime.pid });
    truncateSync(target, 600 * 1024 * 1024);

    const adopted = new Map(),
      context = {
        input: { rootDir, repoId: "oversized-read" },
        publishRuntimeEvent: async () => ({}),
        requiredRuntimeProjection: () => ({
          readRuntimeDispatch: () => ({ source: "local", payload: { dispatchId } }),
          readRuntimeSession(id: string) {
            return (
              this.readRuntimeSessions().find(
                (session: { readonly runtimeSessionId: string }) => session.runtimeSessionId === id,
              ) ?? null
            );
          },
          readRuntimeSessions: () => [
            {
              runtimeSessionId: "runtime_777777777777777777777777",
              liveness: "live",
              outcome: null,
            },
          ],
          readDispatchLifecycle: lifecycleReadFor([
            {
              runtimeSessionId: "runtime_777777777777777777777777",
              dispatchId,
              instanceId: "instance-1",
              process: "alive",
            },
          ]),
        }),
        processes: adopted,
        exiting: new Set<string>(),
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
    assert.deepEqual(active.decisionReviewTarget, {
      decisionId: "dec_PERSISTED_TARGET",
      digest: `sha256:${"a".repeat(64)}`,
    });
    const terminateTree = active.process.terminateTree;
    active.process.terminateTree = async () => {
      terminated = true;
      await terminateTree();
    };
    const receipt = await cancelRuntime(
      {
        ...context,
        // This is a bounded-adoption/physical-stop test. The tail-output case below exercises
        // the full publisher; archiving a sparse 600 MiB invalid JSON line is a separate path.
        publishExit: async (runtime: ActiveRuntime) => {
          published = await runtimeProcessTreeStopped(rootDir, runtime.dispatchId, runtime.process);
          runtime.process.release?.();
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

test("runtime cancel settles provider lines flushed while the provider is terminated", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-dispatch-cancel-tail-"));
  try {
    const dispatchId = "dispatch_bbbbbbbbbbbbbbbbbbbbbbbb",
      runtimeSessionId = "runtime_bbbbbbbbbbbbbbbbbbbbbbbb",
      worker = fixtureRuntimeProcess(t);
    openDispatchStream(rootDir, {
      dispatchId,
      taskId: null,
      executionId: null,
      runtimeSessionId,
      instanceId: "instance-1",
      startedAt: "2026-09-10T00:00:00.000Z",
      binding: { actor: { principal: { personId: "operator" }, executor: null }, source: "local" },
    });
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_started", pid: worker.pid });
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "provider_event", event: { seq: 1 } });
    const consumed: string[] = [],
      settledAfter: number[] = [],
      active = {
        ...tasklessSettlementRuntime(rootDir, "worker stopped"),
        runtimeSessionId,
        dispatchId,
        durableOutputCount: 0,
        process: {
          pid: worker.pid,
          onOutput: () => undefined,
          onErrorOutput: () => undefined,
          onExit: () => undefined,
          terminate: worker.terminate,
          // Cancel holds the write queue, so these lines cannot reach settlement through the drain.
          terminateTree: async () => {
            appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "provider_event", event: { seq: 2 } });
            await worker.terminateTree();
            appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_exit", exitCode: null, signal: "SIGTERM" });
          },
        },
      };
    const receipt = await cancelRuntime(
      withCancellationSettlement(
        {
          input: {
            rootDir,
            repoId: "cancel-tail",
            remote: {
              readDispatchLifecycle: lifecycleReadFor([
                { runtimeSessionId, dispatchId, instanceId: "instance-1", process: "alive" },
              ]),
            },
          },
          processes: new Map([[runtimeSessionId, active]]),
          consumeLine: async (runtime: typeof active, line: string) => {
            runtime.durableOutputCount += 1;
            consumed.push(line);
          },
        },
        () => {
          settledAfter.push(consumed.length);
        },
      ),
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
