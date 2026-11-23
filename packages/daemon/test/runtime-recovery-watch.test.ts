// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { adoptRuntimes, type RuntimeRecoveryResult } from "../src/daemon-host/runtime-spawn-adoption.ts";
import type { RuntimeSpawnerContext } from "../src/daemon-host/runtime-spawn-context.ts";
import { emptyDispatchLifecycleRead } from "./dispatch-lifecycle-read.fixtures.ts";
import { openNodeAutoDispatchLoop, type NodeAutoDispatchCandidate } from "../src/daemon-host/node-auto-dispatch.ts";
import {
  deterministicReplicaConfirmFailure,
  openRuntimeRecoveryWatch,
  renderReplicaConfirmFailure,
  renderStuckRuntimeRecoveries,
  runReplicaConfirmedRound,
  runtimeRecoveryError,
  type RuntimeRecoveryFailure,
} from "../src/daemon-host/runtime-recovery-watch.ts";
import { FleetEdgeGitPreflightError } from "../src/daemon-host/fleet-edge-git-preflight.ts";
import {
  FleetMirrorError,
  mirrorPathsFingerprint,
  pullBlockedMirrorError,
} from "../src/daemon-host/fleet-edge-mirror.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

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
  t.after(() => removeTempRepository(rootDir));
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

  await runReplicaConfirmedRound({
    reconcile: async () => {
      const failed = runtimeRecoveryError(await adoptRuntimes(context));
      if (failed) throw failed;
    },
    observeRecovery: (failures) => observed.push(failures),
    triggers: [async () => undefined, () => autoDispatch.trigger("replica-confirmed")],
  });
  assert.deepEqual(spawned, [reworkCandidate.dispatchKey], "the rework must be dispatched in the same round");
  assert.deepEqual(observed, [[]], "only lifecycle-owned active dispatches enter recovery");
  assert.deepEqual(lifecycle, [], "an orphan session with no dispatch is outside adoption");
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

test("a deterministic mirror failure is isolated from reconcile and auto-dispatch, enters agenda immediately, and clears on recovery", async () => {
  const watch = openRuntimeRecoveryWatch(),
    steps: string[] = [],
    conflictError = pullBlockedMirrorError({
      dirtyPaths: ["tasks/task_1/task_plan.md"],
      conflicts: [],
    });

  await assert.rejects(
    runReplicaConfirmedRound({
      materialize: () => {
        steps.push("materialize");
        throw conflictError;
      },
      observeConfirm: (failure) => watch.observeConfirm("repo-edge", failure, "2026-11-20T05:00:00.000Z", "fp-1"),
      reconcile: async () => {
        steps.push("reconcile");
      },
      observeRecovery: (failures) => watch.observe("repo-edge", failures, "2026-11-20T05:00:00.000Z"),
      triggers: [
        async () => {
          steps.push("auto-claim");
        },
        async () => {
          steps.push("auto-dispatch");
        },
      ],
    }),
    (error: unknown) => (error as { code?: string }).code === "pull_blocked",
  );

  assert.deepEqual(steps, ["materialize", "reconcile", "auto-claim", "auto-dispatch"]);
  const active = watch.confirmFailure("repo-edge");
  assert.ok(active !== null);
  assert.equal(active.code, "pull_blocked");
  assert.deepEqual(active.dirtyPaths, ["tasks/task_1/task_plan.md"]);
  assert.equal(watch.confirmDirtyFingerprint("repo-edge"), "fp-1");
  assert.equal(watch.confirmFailure("repo-other"), null);
  assert.match(
    renderReplicaConfirmFailure(active, "2026-11-20T05:03:10.000Z"),
    /本节点副本确认待处理 \[阻塞\][\s\S]*\[pull_blocked\] 已持续 3 分钟（自 2026-11-20T05:00:00\.000Z）[\s\S]*tasks\/task_1\/task_plan\.md/u,
  );

  assert.equal(watch.noteConfirmFailure("repo-edge", conflictError), true, "first deterministic occurrence logs");
  assert.equal(watch.noteConfirmFailure("repo-edge", conflictError), false, "identical state is suppressed");
  assert.equal(watch.noteConfirmFailure("repo-other", conflictError), true, "deduplication is scoped per repoId");

  const diverged = new FleetEdgeGitPreflightError("edge_default_branch_diverged", "edge branch diverged");
  assert.equal(watch.noteConfirmFailure("repo-edge", diverged), true, "a changed deterministic state logs once");
  assert.equal(watch.noteConfirmFailure("repo-edge", diverged), false, "unchanged diverged state stays suppressed");

  const transient = Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
  assert.equal(deterministicReplicaConfirmFailure(transient), null);
  assert.equal(
    watch.noteConfirmFailure("repo-edge", transient),
    true,
    "transient errors are never latched as deterministic",
  );

  await runReplicaConfirmedRound({
    materialize: () => {
      steps.push("materialize-recovered");
    },
    observeConfirm: (failure) => watch.observeConfirm("repo-edge", failure, "2026-11-20T05:05:00.000Z"),
    reconcile: async () => {
      steps.push("reconcile-recovered");
    },
    observeRecovery: (failures) => watch.observe("repo-edge", failures, "2026-11-20T05:05:00.000Z"),
    triggers: [],
  });

  assert.equal(watch.confirmFailure("repo-edge"), null, "confirmed recovery clears the agenda alert");
  assert.equal(watch.noteConfirmFailure("repo-edge", conflictError), true, "a new conflict after recovery logs again");
});

test("mirrorPathsFingerprint reflects only edits on the tracked conflicting paths", (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "mirror-fingerprint-"));
  t.after(() => removeTempRepository(rootDir));
  assert.equal(mirrorPathsFingerprint(rootDir, []), "");
  const missing = mirrorPathsFingerprint(rootDir, ["tasks/task_1/task_plan.md"]);
  assert.match(missing, /:missing$/u);
  const error = new FleetMirrorError("pull_blocked", "blocked", ["tasks/task_1/task_plan.md"]);
  assert.deepEqual(deterministicReplicaConfirmFailure(error)?.dirtyPaths, ["tasks/task_1/task_plan.md"]);
});
