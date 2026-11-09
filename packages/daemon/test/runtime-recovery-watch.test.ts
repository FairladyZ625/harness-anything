// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { adoptRuntimes, type RuntimeRecoveryResult } from "../src/runtime-spawn-adoption.ts";
import type { RuntimeSpawnerContext } from "../src/runtime-spawn-context.ts";
import { emptyDispatchLifecycleRead } from "./dispatch-lifecycle-read.fixtures.ts";
import { openNodeAutoDispatchLoop, type NodeAutoDispatchCandidate } from "../src/node-auto-dispatch.ts";
import {
  openRuntimeRecoveryWatch,
  renderStuckRuntimeRecoveries,
  runReplicaConfirmedRound,
  runtimeRecoveryError,
  type RuntimeRecoveryFailure,
} from "../src/runtime-recovery-watch.ts";

const reworkCandidate: NodeAutoDispatchCandidate = {
  repoId: "repo-edge",
  taskId: "task_rework",
  executionId: "exe_rework",
  kind: "rework",
  requiredNodeId: "node-edge",
  dispatchKey: "rework:task_rework:exe_rework",
  payload: { taskId: "task_rework" },
};

/** A remote edge whose canonical session has no readable dispatch: adoption can never succeed. */
function unadoptableRuntimeContext(rootDir: string, lifecycle: unknown[]): RuntimeSpawnerContext {
  const session = {
    runtimeSessionId: "runtime_unadoptable",
    instanceId: "reviewer",
    providerSessionId: null,
    liveness: "running" as const,
    outcome: null,
  };
  return {
    input: {
      rootDir,
      now: () => "2026-11-07T10:00:00.000Z",
      recordLifecycle: (event: unknown) => lifecycle.push(event),
      remote: {
        readRuntimeSessions: async () => [session],
        readRuntimeDispatch: async () => null,
        readDispatchLifecycle: emptyDispatchLifecycleRead,
      },
    },
    processes: new Map(),
    exiting: new Set(),
    runtimeSpawnError: (code: string, message: string) => Object.assign(new Error(message), { code }),
  } as unknown as RuntimeSpawnerContext;
}

test("an unadoptable runtime does not stop the same confirmed round from dispatching a pending rework", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-recovery-watch-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  t.mock.method(console, "error", () => undefined);
  const lifecycle: unknown[] = [],
    observed: (readonly RuntimeRecoveryFailure[] | null)[] = [],
    spawned: string[] = [];
  const context = unadoptableRuntimeContext(rootDir, lifecycle);
  const autoDispatch = openNodeAutoDispatchLoop({
    read: async () => [reworkCandidate],
    spawn: async (candidate) => {
      spawned.push(candidate.dispatchKey);
    },
  });
  t.after(() => autoDispatch.close());

  await assert.rejects(
    runReplicaConfirmedRound({
      // The edge reconcile's own contract: recover every runtime, then raise every failure.
      reconcile: async () => {
        const failed = runtimeRecoveryError(await adoptRuntimes(context));
        if (failed) throw failed;
      },
      observeRecovery: (failures) => observed.push(failures),
      triggers: [async () => undefined, () => autoDispatch.trigger("replica-confirmed")],
    }),
    (error: Error & { code?: string }) => {
      // The failure is still reported, with the runtime and its own code, not swallowed.
      assert.equal(error.code, "runtime_recovery_missing_dispatch");
      assert.match(error.message, /runtime_unadoptable \[runtime_recovery_missing_dispatch\]/u);
      return true;
    },
  );
  assert.deepEqual(spawned, [reworkCandidate.dispatchKey], "the rework must be dispatched in the same round");
  assert.deepEqual(observed, [
    [
      {
        runtimeSessionId: "runtime_unadoptable",
        dispatchId: null,
        code: "runtime_recovery_missing_dispatch",
        message: "Runtime runtime_unadoptable has no readable dispatch.",
      },
    ],
  ]);
  assert.deepEqual(
    lifecycle.map((entry) => {
      const { event, runtimeSessionId, code } = entry as Record<string, unknown>;
      return { event, runtimeSessionId, code };
    }),
    [
      {
        event: "runtime_recovery_failed",
        runtimeSessionId: "runtime_unadoptable",
        code: "runtime_recovery_missing_dispatch",
      },
    ],
  );
});

test("a failed auto-claim trigger does not stop auto-dispatch, and every failure surfaces", async () => {
  const ran: string[] = [];
  await assert.rejects(
    runReplicaConfirmedRound({
      reconcile: async () => {
        throw Object.assign(new Error("center unreachable"), { code: "ECONNREFUSED" });
      },
      observeRecovery: (failures) => assert.equal(failures, null, "a scan without verdicts changes no runtime"),
      triggers: [
        async () => {
          ran.push("claim");
          throw new Error("claim read failed");
        },
        async () => {
          ran.push("dispatch");
        },
      ],
    }),
    (error: AggregateError) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(
        error.errors.map((entry: Error) => entry.message),
        ["center unreachable", "claim read failed"],
      );
      return true;
    },
  );
  assert.deepEqual(ran, ["claim", "dispatch"]);
});

test("a scan error names every failed runtime; one failure keeps its own code", () => {
  const failed = (runtimeSessionId: string, code: string): RuntimeRecoveryResult => ({
    runtimeSessionId,
    dispatchId: `dispatch_${runtimeSessionId}`,
    outcome: "failed",
    error: Object.assign(new Error(`${runtimeSessionId} broke`), { code }),
  });
  const ready: RuntimeRecoveryResult = { runtimeSessionId: "runtime_ok", dispatchId: null, outcome: "ready" };
  assert.equal(runtimeRecoveryError([ready]), null);
  const many = runtimeRecoveryError([failed("runtime_a", "review_admission_denied"), ready, failed("runtime_b", "x")]);
  assert.equal((many as Error & { code?: string }).code, "runtime_recovery_failed");
  assert.match(many!.message, /runtime_a \[review_admission_denied\].*runtime_b \[x\]/u);
  assert.equal(
    (runtimeRecoveryError([failed("runtime_a", "review_admission_denied")]) as Error & { code?: string }).code,
    "review_admission_denied",
  );
});

test("the watch reports a runtime only after it keeps failing, and forgets it once a scan recovers it", () => {
  const watch = openRuntimeRecoveryWatch();
  const failure: RuntimeRecoveryFailure = {
    runtimeSessionId: "runtime_03449bd7",
    dispatchId: "dispatch_reviewer",
    code: "review_admission_denied",
    message: "Task task_5963d4c3 is not in review.",
  };
  watch.observe("repo-edge", [failure], "2026-11-07T11:11:55.000Z");
  assert.deepEqual(watch.stuck("repo-edge", "2026-11-07T11:12:30.000Z"), [], "a transient failure stays quiet");
  watch.observe("repo-edge", [failure], "2026-11-07T11:20:00.000Z");
  watch.observe("repo-edge", null, "2026-11-07T11:21:00.000Z");
  const at = "2026-11-07T11:41:38.000Z",
    stuck = watch.stuck("repo-edge", at);
  assert.deepEqual(stuck, [
    { ...failure, firstFailedAt: "2026-11-07T11:11:55.000Z", lastFailedAt: "2026-11-07T11:20:00.000Z" },
  ]);
  assert.deepEqual(watch.stuck("repo-other", at), []);
  assert.equal(
    renderStuckRuntimeRecoveries(stuck, at),
    "本节点 runtime 清点卡住 (1) — 收养/结算持续失败；其余 runtime 与自动派工不受影响，详情见 lifecycle 日志 runtime_recovery_failed\n" +
      "- runtime_03449bd7 / dispatch dispatch_reviewer [review_admission_denied] 已持续 29 分钟（自 2026-11-07T11:11:55.000Z）— Task task_5963d4c3 is not in review.",
  );
  watch.observe("repo-edge", [], at);
  assert.deepEqual(watch.stuck("repo-edge", "2026-11-07T12:00:00.000Z"), []);
});
