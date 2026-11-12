// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import type { ActorIdentity, LeaseV1, TaskLifecycleSnapshot, TaskV2 } from "@harness-anything/kernel";
import { parseRuntimeBatchEntry } from "../src/runtime-orchestration.ts";
import { deriveSquadChildPlan, reacquireSquadTaskLease } from "../src/repo-cell-squad-child.ts";
import {
  callbackLeaderPrompt,
  initialLeaderPrompt,
  parseLeaderDecision,
  squadAttemptStatus,
} from "../src/squad-leader-decision.ts";
import type { TaskDispatchRow } from "../src/protocol/daemon-protocol.contract.ts";
import {
  emptyTaskLifecycleSnapshot,
  normalizeTaskLifecycleCommand,
  reduceTaskEvent,
  taskCompletionNext,
} from "@harness-anything/kernel";
import { validateTransition } from "@harness-anything/kernel/internal/domain/task-lifecycle.contract";
import { lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";
import { actionCriterionFailure } from "../src/repo-cell-errors.ts";

test("show, squad and transition agree on lease ownership and give executable recovery", async (t) => {
  const active = lifecycleFixture().events.slice(0, 2).reduce(reduceTaskEvent, emptyTaskLifecycleSnapshot());
  for (const [phase, own] of [
    ["orphaned", true],
    ["orphaned", false],
    ["held", false],
  ] as const) {
    const actor = own
        ? active.lease!.actor
        : { ...active.lease!.actor, executor: { kind: "agent" as const, id: "other-session" } },
      snapshot = { ...active, lease: { ...active.lease!, phase } },
      next = taskCompletionNext(snapshot, {
        closeout: "ready",
        closeoutPath: "tasks/task-1/closeout.md",
        eligibleDirtyPaths: [],
        actor,
      }).next!,
      issues = validateTransition(
        snapshot,
        {
          ...normalizeTaskLifecycleCommand(
            {
              workspaceId: "workspace-1",
              actor,
              source: "local",
              expectedRevision: snapshot.revision,
            },
            { type: "TransitionTask", taskId: "task-1", status: "planned", reason: "Reset the round" },
          ),
          workspaceRevision: snapshot.revision + 1,
          eventId: "lease-receipt-transition",
          occurredAt: "2026-11-12T00:00:00.000Z",
        },
        {} as never,
      );
    let starts = 0;
    await assert.rejects(
      reacquireSquadTaskLease({
        taskId: "task-1",
        binding: { actor, source: "local" },
        snapshot,
        start: async () => {
          starts += 1;
          return { outcome: "applied" };
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        t.diagnostic(JSON.stringify({ own, show: next, squad: error.message, transition: issues }));
        const holder = own ? /held by you/u : /held by another actor/u;
        for (const message of [next.reason, error.message, issues[0]!.message]) {
          assert.ok(message.includes(phase), message);
          assert.match(message, holder);
          assert.doesNotMatch(message, /lease was released/u);
        }
        const action = phase === "orphaned" ? "ha task start task-1" : "ha task release task-1";
        assert.equal(next.action, action);
        assert.deepEqual(actionCriterionFailure(error)?.nextActions, [action]);
        assert.match(issues[0]!.message, /ha task release task-1/u);
        return true;
      },
    );
    assert.equal(starts, 0);
  }
});

test("released leases reconnect and held self leases continue without changing lease semantics", async () => {
  const active = lifecycleFixture().events.slice(0, 2).reduce(reduceTaskEvent, emptyTaskLifecycleSnapshot()),
    actor = active.lease!.actor;
  for (const lease of [null, active.lease]) {
    const snapshot = { ...active, lease };
    let starts = 0;
    await reacquireSquadTaskLease({
      taskId: "task-1",
      binding: { actor, source: "local" },
      snapshot,
      start: async (executionId) => {
        assert.equal(executionId, active.executions[0]!.executionId);
        starts += 1;
        return { outcome: "applied" };
      },
    });
    assert.equal(starts, lease === null ? 1 : 0);
    const next = taskCompletionNext(snapshot, {
      closeout: "ready",
      closeoutPath: "tasks/task-1/closeout.md",
      eligibleDirtyPaths: [],
      actor,
    }).next!;
    assert.equal(next.action, lease === null ? "ha task start task-1" : "ha task submit task-1");
    assert.match(next.reason, lease === null ? /lease was released/u : /held by you/u);
  }
});

const squadActor: ActorIdentity = {
    principal: { personId: "person-squad" },
    executor: { kind: "agent", id: "squad-runner" },
  },
  task: TaskV2 = {
    schema: "task/v2",
    taskId: "task-squad-reacquire",
    title: "Squad reacquire",
    taskClass: "standard",
    status: "active",
    graph: { maxIterations: 1, nodes: [], edges: [] },
    currentNode: "implementation",
    iteration: 0,
    createdBy: squadActor,
    completionGateIds: [],
    presetSnapshotDigest: null,
    pinned: false,
  };

test("squad lease reacquisition reports conflict when another actor takes the released execution", async () => {
  const execution = {
      schema: "execution/v1" as const,
      executionId: "execution-squad-reacquire",
      taskId: task.taskId,
      nodeId: "implementation" as const,
      iteration: 0,
      state: "active" as const,
      actor: squadActor,
      claimedAt: "2026-08-27T00:00:00.000Z",
      submittedAt: null,
      closedAt: null,
      submission: null,
    },
    foreignLease: LeaseV1 = {
      schema: "lease/v1",
      taskId: task.taskId,
      executionId: execution.executionId,
      actor: {
        principal: { personId: "person-other" },
        executor: { kind: "agent", id: "other-runner" },
      },
      source: "local",
      phase: "held",
      expiresAt: "2026-08-28T00:00:00.000Z",
      ttlMs: 86_400_000,
      version: 2,
    },
    snapshot: TaskLifecycleSnapshot = {
      revision: 3,
      task,
      executions: [execution],
      reviews: [],
      consents: [],
      gateWitnesses: [],
      edgesTaken: [],
      lease: foreignLease,
    };
  let starts = 0;

  await assert.rejects(
    reacquireSquadTaskLease({
      taskId: task.taskId,
      binding: { actor: squadActor, source: "local" },
      snapshot,
      start: () => {
        starts += 1;
        return Promise.resolve({ outcome: "applied" });
      },
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "lease_conflict",
  );
  assert.equal(starts, 0, "a conflicting lease must not be reacquired or overwritten");
});

test("squad child plans inherit the parent contract and apply assignment sections", () => {
  const parent = [
    "# Parent",
    "",
    "## Brief",
    "",
    "Parent brief.",
    "",
    "## Required Reading",
    "",
    "Read the parent contract.",
    "",
    "## Verification",
    "",
    "Run the parent verification.",
    "",
  ].join("\n");
  const derived = deriveSquadChildPlan(
    parent,
    "## Brief\n\nWorker brief.\n\n## Implementation Plan\n\nImplement the bounded change.",
  );
  assert.match(derived, /## Brief\n\nWorker brief\./u);
  assert.match(derived, /## Required Reading\n\nRead the parent contract\./u);
  assert.match(derived, /## Verification\n\nRun the parent verification\./u);
  assert.match(derived, /## Worker Assignment\n\nImplement the bounded change\./u);
});

test("squad child derivation does not fill a missing parent readiness section", () => {
  const parent = "# Parent\n\n## Brief\n\nParent brief.\n";
  const derived = deriveSquadChildPlan(parent, "## Verification\n\nWorker verification.");
  assert.doesNotMatch(derived, /^## Verification\n\nWorker verification\./mu);
});

test("squad child derivation retains a plain-text assignment", () => {
  const derived = deriveSquadChildPlan("# Parent\n\n## Brief\n\nParent brief.\n", "Implement the bounded change.");
  assert.match(derived, /## Worker Assignment\n\nImplement the bounded change\./u);
});

test("runtime-batch leaves worker instance selection to the harness", () => {
  const prompt = initialLeaderPrompt({
      squadRunId: "squad_0123456789abcdef01234567",
      subject: { kind: "task" },
      roster: "worker -> terra\nsynthesis -> artifacts/reports/{squadRunId}.md",
      mission: "Review the runtime boundary.",
      workerAttempts: [],
    }),
    decision = parseLeaderDecision(
      JSON.stringify({ schema: "runtime-batch/v1", dispatches: [{ to: "terra", prompt: "Review it." }] }),
      ["terra"],
    );

  assert.doesNotMatch(prompt, /"instance"/u);
  assert.match(prompt, /converged decision's report field/u);
  assert.doesNotMatch(prompt, /task artifact add|untracked source/u);
  assert.deepEqual(decision, {
    kind: "plan",
    dispatches: [{ workerId: "terra", prompt: "Review it." }],
  });
  assert.throws(
    () =>
      parseLeaderDecision(
        JSON.stringify({
          schema: "runtime-batch/v1",
          dispatches: [{ instance: "leader-instance", to: "terra", prompt: "Review it." }],
        }),
        ["terra"],
      ),
    /Leader dispatch contains harness-owned fields\./u,
  );
});

test("runtime-batch effort validation follows the runtime-run declaration", () => {
  assert.equal(parseRuntimeBatchEntry({ instance: "codex-one", prompt: "Work.", effort: "xhigh" }, 0).effort, "xhigh");
  assert.throws(
    () => parseRuntimeBatchEntry({ instance: "codex-one", prompt: "Work.", effort: "turbo" }, 0),
    /Batch dispatch 0 effort must be minimal, low, medium, high, xhigh, max\./u,
  );
});

test("converged decisions carry the synthesis report while missing content remains a convergence error", () => {
  assert.deepEqual(
    parseLeaderDecision(
      JSON.stringify({ schema: "squad-decision/v1", action: "converged", report: "# Synthesis\n\nDone." }),
      ["terra"],
    ),
    { kind: "converged", report: "# Synthesis\n\nDone." },
  );
  assert.deepEqual(
    parseLeaderDecision(JSON.stringify({ schema: "squad-decision/v1", action: "converged" }), ["terra"]),
    { kind: "converged", report: null },
  );
});

test("an unavailable immutable worker result explicitly fails callback synthesis", () => {
  assert.throws(
    () =>
      callbackLeaderPrompt(
        {
          squadRunId: "squad_0123456789abcdef01234567",
          subject: { kind: "task" },
          roster: "worker -> terra\nsynthesis -> artifacts/reports/{squadRunId}.md",
          mission: "Synthesize worker evidence.",
          workerAttempts: [
            {
              attemptId: "attempt-1",
              taskId: "task-child",
              executionId: "execution-child",
              ownedPaths: [],
              ownershipCheck: null,
              workerId: "terra",
              leaderTurnId: "turn-1",
              dispatchId: "dispatch-1",
              runtimeSessionId: "runtime-1",
              worktree: null,
              rejection: null,
            },
          ],
        },
        [{ kind: "worker_outcome", runtimeSessionId: "runtime-1" }],
        [
          {
            taskId: "task-squad",
            dispatchId: "dispatch-1",
            runtimeSessionId: "runtime-1",
            status: "succeeded",
            exitCode: 0,
            resultRef: `artifact:runtime-result/sha256/${"1".repeat(64)}`,
            reportPath: "artifacts/report.md",
          },
        ],
        (resultRef) => {
          throw new Error(`Runtime result ${resultRef} is unavailable.`);
        },
      ),
    /Runtime result artifact:runtime-result\/sha256\/[0-9a-f]{64} is unavailable\./u,
  );
});

test("leader protocol preserves finite child ownership and rejects glob or parent-relative scopes", () => {
  const parse = (ownedPaths: readonly string[]) =>
    parseLeaderDecision(
      JSON.stringify({
        schema: "runtime-batch/v1",
        dispatches: [{ to: "terra", prompt: "Complete this child task.", ownedPaths }],
      }),
      ["terra"],
    );
  assert.deepEqual(parse(["src/parser/", "README.md"]), {
    kind: "plan",
    dispatches: [
      {
        workerId: "terra",
        prompt: "Complete this child task.",
        ownedPaths: ["src/parser/", "README.md"],
      },
    ],
  });
  for (const scope of ["src/**", "../outside", "/absolute", "src/{a,b}/", "src/../other"])
    assert.throws(() => parse([scope]), Error, `invalid ownership scope was accepted: ${scope}`);
});

test("the callback prompt and the status receipt share one attempt-status judgment", () => {
  const rejection = "TASK_WIP_LIMIT_REACHED: Execution worktable is full (40/40; settings.tasks.wipLimit=40).";
  assert.equal(squadAttemptStatus(rejection, undefined), "rejected");
  assert.equal(squadAttemptStatus(null, undefined), "running");
  const row = { status: "succeeded" } as TaskDispatchRow;
  assert.equal(squadAttemptStatus(null, row), "succeeded");
  // 详细 callback 的状态行必须经同一判定:拒绝优先于台账行,不再是各渲染面的私有推断。
  const prompt = callbackLeaderPrompt(
    {
      squadRunId: "squad_0123456789abcdef01234567",
      subject: { kind: "task" },
      roster: "worker -> terra\nsynthesis -> artifacts/reports/{squadRunId}.md",
      mission: "Synthesize worker evidence.",
      workerAttempts: [
        {
          attemptId: "attempt-1",
          taskId: null,
          executionId: null,
          ownedPaths: [],
          ownershipCheck: null,
          workerId: "terra",
          leaderTurnId: "turn-1",
          dispatchId: null,
          runtimeSessionId: null,
          worktree: null,
          rejection,
        },
      ],
    },
    [{ kind: "worker_rejected", attemptId: "attempt-1" }],
    [],
    () => null,
  );
  assert.ok(prompt.includes("status=rejected"), "callback status row must show the rejected judgment");
  assert.ok(prompt.includes(`rejection=${rejection}`), "callback status row must carry the rejection reason");
});
