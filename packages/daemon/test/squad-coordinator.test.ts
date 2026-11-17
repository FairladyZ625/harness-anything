// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  buildHandoffPacket,
  type ActorIdentity,
  type AgentRuntimeEventV1,
  type DispatchLifecycleQuery,
  type DispatchLifecycleView,
  type LeaseV1,
  type RuntimeSession,
  type TaskLifecycleSnapshot,
  type TaskProjection,
  type TaskV2,
} from "@harness-anything/kernel";
import type { JsonObject } from "../src/protocol/json-rpc-types.ts";
import { dispatchStreamPath } from "../src/dispatch-stream.ts";
import { makeSquadCoordinator } from "../src/squad-coordinator.ts";
import { noWorktreeSetup } from "../src/worktree-setup.ts";
import { initRepo } from "./task-surface.fixtures.ts";
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

test("parseLeaderDecision validates continuationMode and optional HandoffPacketV1", () => {
  const handoff = buildHandoffPacket({
    handoffId: "handoff-1",
    revision: 1,
    mode: "transfer",
    expiresAt: "2026-11-18T00:00:00.000Z",
    work: { id: "task-1", title: "Test", description: "Test", specRevision: 1, specDigest: "sha256:" + "a".repeat(64) },
    sourceEmployeeId: "terra",
    target: { employeeId: "hydrogen", name: "hydrogen" },
  }).packet;
  const parsed = parseLeaderDecision(
    JSON.stringify({
      schema: "runtime-batch/v1",
      dispatches: [
        { to: "terra", prompt: "Continue.", continuationMode: "continue" },
        { to: "hydrogen", prompt: "Take over.", continuationMode: "handoff", handoffPacket: handoff },
      ],
    }),
    ["terra", "hydrogen"],
  );
  assert.equal(parsed.kind, "plan");
  if (parsed.kind === "plan") {
    assert.equal(parsed.dispatches[0]?.continuationMode, "continue");
    assert.equal(parsed.dispatches[1]?.continuationMode, "handoff");
    assert.equal(parsed.dispatches[1]?.handoffPacket?.handoffId, "handoff-1");
  }
  assert.throws(
    () =>
      parseLeaderDecision(
        JSON.stringify({
          schema: "runtime-batch/v1",
          dispatches: [{ to: "terra", prompt: "Invalid.", continuationMode: "rewind" }],
        }),
        ["terra"],
      ),
    /Leader dispatch continuationMode must be continue, fresh, or handoff\./u,
  );
});

function createSquadCoordinatorHarness(
  t: TestContext,
  options: {
    readonly leaderResponses: readonly string[];
    readonly onWorkerSpawn?: (
      payload: JsonObject,
      attempt: number,
    ) => { readonly outcome?: "ok" | "throw"; readonly error?: Error };
  },
) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-squad-cont-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  initRepo(rootDir);

  let seq = 0;
  let leaderTurn = 0;
  let workerAttemptSeq = 0;
  const results = new Map<string, string>(),
    dispatches = new Map<string, Extract<AgentRuntimeEventV1, { readonly type: "runtime_dispatch_requested" }>>(),
    sessions = new Map<string, RuntimeSession>(),
    lifecycles = new Map<string, DispatchLifecycleView>(),
    childTasks = new Map<string, { status: string; lease: LeaseV1 | null }>(),
    spawnCalls: JsonObject[] = [],
    degradedEvents: Array<{ readonly payload: Record<string, unknown>; readonly opId: string }> = [];

  const binding = { actor: squadActor, source: "local" as const };
  const buildLifecycleView = (
    dispatchId: string,
    runtimeSessionId: string,
    outcome: RuntimeSession["outcome"],
    stopProof: "proven_stopped" | "unproven",
  ): DispatchLifecycleView =>
    ({
      attemptGroupId: dispatchId,
      controlLeafDispatchId: dispatchId,
      groupDispatchIds: [dispatchId],
      groupPhase: outcome === null ? "running" : "closed",
      revision: seq,
      attempt: {
        dispatchId,
        runtimeSessionId,
        instanceId: "codex-one",
        phase: outcome === null ? "running" : "closed",
        stopProof,
        process: outcome === null ? "alive" : "exited",
        outcome,
      },
      successor: { admissible: false, dueAt: null },
      ruling: null,
      delivery: {
        status: "unregistered",
        targetRef: null,
        targetDigest: null,
        registeredRevision: null,
      },
      policy: {
        attemptSettled: outcome !== null,
        groupSettled: outcome !== null,
        consentBlocked: false,
        fallbackPending: false,
        capacity: outcome === null ? "held" : "released",
        capacityDisposition: outcome === null ? "occupied" : "released",
        successorAdmissible: false,
        canResolveRuling: false,
        canRecover: false,
        canSteer: outcome === null,
        canAdoptProcess: false,
        canHandoff: false,
        canWrite: outcome === null,
        canPublish: outcome === null,
        ownsWorkspace: outcome === null,
      },
    }) as unknown as DispatchLifecycleView;
  const recordOutcome = (params: {
    readonly dispatchId: string;
    readonly runtimeSessionId: string;
    readonly agentId: string;
    readonly taskId?: string;
    readonly squadTurnId: string;
    readonly squadRunId: string;
    readonly outcome: RuntimeSession["outcome"];
    readonly stopProof: "proven_stopped" | "unproven";
    readonly providerSessionId: string | null;
    readonly resultBody: string;
  }) => {
    const resultRef = `artifact:runtime-result/sha256/${String(++seq).padStart(64, "0")}`;
    results.set(resultRef, params.resultBody);
    const dispatchEvent = {
      schema: "agent-runtime-event/v1",
      eventId: `event-${params.dispatchId}`,
      workspaceRevision: seq,
      opId: `op-${params.dispatchId}`,
      actor: squadActor,
      source: "local",
      occurredAt: "2026-11-17T00:00:00.000Z",
      type: "runtime_dispatch_requested",
      payload: {
        dispatchId: params.dispatchId,
        runtimeSessionId: params.runtimeSessionId,
        instanceId: "codex-one",
        installationId: "install-codex",
        kindId: "codex",
        dispatchKey: `dk-${params.dispatchId}`,
        definitionSnapshotRef: "artifact:runtime-definition/sha256/" + "a".repeat(64),
        definitionSnapshot: {
          schema: "agent-definition-snapshot/v1",
          configVersion: 1,
          instanceId: "codex-one",
          installationId: "install-codex",
          kindId: "codex",
          providerId: "openai",
          model: "gpt-5",
          reasoningEffort: null,
          baseUrl: null,
          authMode: "subscription",
        },
        ...(params.taskId ? { taskId: params.taskId, executionId: `exe-${params.taskId}` } : {}),
        agentId: params.agentId,
        squadId: "core-squad",
        squadRun: {
          squadRunId: params.squadRunId,
          ownerDispatchId: "dispatch_000000000000000000000001",
          turnId: params.squadTurnId,
        },
        cwd: rootDir,
      },
    } as Extract<AgentRuntimeEventV1, { readonly type: "runtime_dispatch_requested" }>;
    dispatches.set(params.dispatchId, dispatchEvent);
    sessions.set(params.runtimeSessionId, {
      schema: "runtime-session/v1",
      runtimeSessionId: params.runtimeSessionId,
      instanceId: "codex-one",
      installationId: "install-codex",
      kindId: "codex",
      definitionSnapshotRef: dispatchEvent.payload.definitionSnapshotRef,
      launchGeneration: 1,
      attachable: false,
      liveness: "exited",
      providerSessionId: params.providerSessionId,
      transcriptRef: null,
      providerUnreachable: null,
      taskBindings: [],
      cancelledBy: null,
      outcome: params.outcome,
      exitCode: params.outcome === "succeeded" ? 0 : 1,
      resultRef,
      reasonCode: null,
      startedAt: "2026-11-17T00:00:00.000Z",
      lastObservedAt: "2026-11-17T00:00:01.000Z",
    });
    lifecycles.set(
      params.dispatchId,
      buildLifecycleView(params.dispatchId, params.runtimeSessionId, params.outcome, params.stopProof),
    );
  };

  const projection = {
    getEntity: (kind: string, id: string) => {
      if (kind === "schedule" && id === "sched-1")
        return { value: { status: { activeRun: { claimFence: "fence-1" } } } };
      if (kind === "squad" && id === "core-squad")
        return {
          value: {
            schema: "squad-declaration/v1",
            id: "core-squad",
            name: "Core Squad",
            leader: "fable",
            workers: ["terra", "hydrogen"],
            leaderTurnBudget: 8,
            roster: "worker -> terra\nworker -> hydrogen",
          },
        };
      if (kind === "agent")
        return {
          value: {
            schema: "agent-declaration/v1",
            id,
            name: id,
            instructions: "Work.",
            runtimes: [],
          },
        };
      return null;
    },
    read: (taskId: string) => {
      const child = childTasks.get(taskId);
      return {
        snapshot: {
          task: {
            taskId,
            title: taskId,
            status: child?.status ?? "active",
            iteration: 0,
            currentNode: "implementation",
          },
          executions: [{ executionId: `exe-${taskId}`, iteration: 0, state: "active", actor: squadActor }],
          lease: child?.lease ?? null,
        },
        packagePath: `harness/tasks/${taskId}`,
      };
    },
    readTaskIndex: ({ taskIds }: { readonly taskIds: readonly string[] }) => ({
      status: "ready" as const,
      rows: taskIds.map((taskId) => ({ taskId, title: taskId, packagePath: `harness/tasks/${taskId}` })),
    }),
    readDocument: () => ({ document: null }),
    readDocumentHistory: () => ({ document: null }),
    readSquadRuns: () => [],
    readSquadRun: () => null,
    readRuntimeDispatchById: (dispatchId: string) => {
      const event = dispatches.get(dispatchId);
      return event ? { event } : null;
    },
    readRuntimeDispatchesByTaskIds: (taskIds: readonly string[]) =>
      [...dispatches.values()].filter(
        (event) => typeof event.payload.taskId === "string" && taskIds.includes(event.payload.taskId),
      ),
    readRuntimeDispatch: (runtimeSessionId: string) =>
      [...dispatches.values()].find((event) => event.payload.runtimeSessionId === runtimeSessionId) ?? null,
    readRuntimeSession: (runtimeSessionId: string) => sessions.get(runtimeSessionId) ?? null,
    readRuntimeSessionEventsByType: () => [],
    readDispatchLifecycle: (query: DispatchLifecycleQuery) => {
      if (query.by === "dispatch")
        return {
          status: "ready" as const,
          watermark: seq,
          sourceRevision: seq,
          rows: query.dispatchIds.flatMap((id) => {
            const view = lifecycles.get(id);
            return view ? [view] : [];
          }),
          nextCursor: null,
        };
      return { status: "ready" as const, watermark: seq, sourceRevision: seq, rows: [], nextCursor: null };
    },
  } as unknown as TaskProjection;

  let latestLeader: { readonly dispatchId: string; readonly runtimeSessionId: string } | null = null;
  let latestWorker: { readonly dispatchId: string; readonly runtimeSessionId: string } | null = null;
  const spawnImpl = async (
    payload: JsonObject,
    _binding: unknown,
    onPrepared?: (dispatchId: string, runtimeSessionId: string) => void,
  ): Promise<JsonObject> => {
    const isWorker = typeof payload.targetAgentId === "string";
    const idx = ++seq;
    const dispatchId = `dispatch_${String(idx).padStart(24, "0")}`;
    const runtimeSessionId = `runtime-${idx}`;
    const streamFile = dispatchStreamPath(rootDir, dispatchId);
    mkdirSync(path.dirname(streamFile), { recursive: true });
    writeFileSync(streamFile, "");
    onPrepared?.(dispatchId, runtimeSessionId);
    if (isWorker) {
      spawnCalls.push(payload);
      workerAttemptSeq += 1;
      const hook = options.onWorkerSpawn?.(payload, workerAttemptSeq);
      if (hook?.outcome === "throw") throw hook.error!;
      const squadRun = payload.squadRun as { readonly squadRunId: string; readonly turnId: string };
      latestWorker = { dispatchId, runtimeSessionId };
      recordOutcome({
        dispatchId,
        runtimeSessionId,
        agentId: String(payload.targetAgentId),
        taskId: String(payload.taskId),
        squadTurnId: squadRun.turnId,
        squadRunId: squadRun.squadRunId,
        outcome: null,
        stopProof: "unproven",
        providerSessionId: `prov-${String(payload.targetAgentId)}-${workerAttemptSeq}`,
        resultBody: "worker result",
      });
      return { ok: true, outcome: "applied", dispatchId, runtimeSessionId };
    }
    const turnIdx = leaderTurn++;
    const squadRun = payload.squadRun as { readonly squadRunId: string; readonly turnId?: string };
    latestLeader = { dispatchId, runtimeSessionId };
    recordOutcome({
      dispatchId,
      runtimeSessionId,
      agentId: "fable",
      squadTurnId: squadRun.turnId ?? "leader-1",
      squadRunId: squadRun.squadRunId,
      outcome: "succeeded",
      stopProof: "proven_stopped",
      providerSessionId: "prov-leader-1",
      resultBody:
        options.leaderResponses[turnIdx] ?? JSON.stringify({ schema: "squad-decision/v1", action: "waiting" }),
    });
    return { ok: true, outcome: "applied", dispatchId, runtimeSessionId };
  };

  const coordinator = makeSquadCoordinator({
    rootDir,
    now: () => "2026-11-17T00:00:00.000Z",
    publishObservation: async () => undefined,
    readWorktreeSetup: noWorktreeSetup,
    query: (read) => read(projection),
    readDispatchLifecycle: (query) => projection.readDispatchLifecycle(query),
    readResult: (ref) => results.get(ref) ?? "",
    reacquireTaskLease: async (taskId) => {
      const child = childTasks.get(taskId);
      if (child)
        child.lease = {
          schema: "lease/v1",
          taskId,
          executionId: `exe-${taskId}`,
          actor: squadActor,
          source: "local",
          phase: "held",
          expiresAt: "2026-11-18T00:00:00.000Z",
          ttlMs: 86_400_000,
          version: 1,
        };
    },
    releaseTaskLease: async () => undefined,
    settleScheduleOccurrence: async () => undefined,
    settleChildTask: async (child) => {
      const existing = childTasks.get(child.taskId);
      if (existing) existing.status = "cancelled";
    },
    createChildTask: async (_child) => {
      const taskId = `task-child-${++seq}`;
      childTasks.set(taskId, { status: "active", lease: null });
      return taskId;
    },
    recordOwnershipCheck: async () => undefined,
    publishSynthesisReport: async () => undefined,
    publishResumeDegraded: (payload, _binding, opId) => {
      degradedEvents.push({ payload: payload as Record<string, unknown>, opId });
    },
    runtimeSpawner: () => ({
      spawn: spawnImpl,
      spawnScheduled: (payload, _scheduled, bindingArg, onPrepared) => spawnImpl(payload, bindingArg, onPrepared),
      cancel: async () => ({ ok: true }),
    }),
  });

  const completeLeaderTurn = async () => {
    const leader = latestLeader!;
    return coordinator.observeOutcome({
      schema: "agent-runtime-event/v1",
      eventId: `event-leader-${++seq}`,
      workspaceRevision: seq,
      opId: `op-leader-${seq}`,
      actor: squadActor,
      source: "local",
      occurredAt: "2026-11-17T00:00:01.000Z",
      type: "runtime_session_outcome_observed",
      payload: {
        runtimeSessionId: leader.runtimeSessionId,
        dispatchId: leader.dispatchId,
        outcome: "succeeded",
        exitCode: 0,
        resultRef: sessions.get(leader.runtimeSessionId)!.resultRef!,
      },
    } as Extract<AgentRuntimeEventV1, { readonly type: "runtime_session_outcome_observed" }>);
  };

  return {
    coordinator,
    binding,
    spawnCalls,
    degradedEvents,
    latestWorker: () => latestWorker,
    completeLeaderTurn,
    startRun: () =>
      coordinator.startScheduled(
        {
          squadId: "core-squad",
          subject: {
            kind: "schedule-occurrence",
            scheduleId: "sched-1",
            occurrenceId: "occ-1",
            claimFence: "fence-1",
          },
          schedule: { scheduleId: "sched-1", occurrenceId: "occ-1", claimFence: "fence-1", mode: "detect" },
          mission: "Test worker continuation.",
          cwd: rootDir,
        },
        binding,
      ),
    setWorkerTerminal: (
      dispatchId: string,
      runtimeSessionId: string,
      opts: {
        readonly outcome?: RuntimeSession["outcome"];
        readonly stopProof?: "proven_stopped" | "unproven";
        readonly providerSessionId?: string | null;
      },
    ) => {
      const prevDispatch = dispatches.get(dispatchId)!;
      const prevSession = sessions.get(runtimeSessionId)!;
      sessions.set(runtimeSessionId, {
        ...prevSession,
        outcome: opts.outcome ?? "succeeded",
        ...(opts.providerSessionId !== undefined ? { providerSessionId: opts.providerSessionId } : {}),
      });
      lifecycles.set(
        dispatchId,
        buildLifecycleView(
          dispatchId,
          runtimeSessionId,
          opts.outcome ?? "succeeded",
          opts.stopProof ?? "proven_stopped",
        ),
      );
      return coordinator.observeOutcome({
        schema: "agent-runtime-event/v1",
        eventId: `event-outcome-${++seq}`,
        workspaceRevision: seq,
        opId: `op-outcome-${seq}`,
        actor: squadActor,
        source: "local",
        occurredAt: "2026-11-17T00:00:02.000Z",
        type: "runtime_session_outcome_observed",
        payload: {
          runtimeSessionId: prevDispatch.payload.runtimeSessionId,
          dispatchId,
          outcome: opts.outcome ?? "succeeded",
          exitCode: 0,
          resultRef: prevSession.resultRef!,
        },
      } as Extract<AgentRuntimeEventV1, { readonly type: "runtime_session_outcome_observed" }>);
    },
  };
}

test("squad-coordinator enforces WorkerPlan.continuationMode for continue, degraded fallback, and handoff", async (t) => {
  // 1. Same employee + proven_stopped + continue => reuses providerSessionId
  {
    const h = createSquadCoordinatorHarness(t, {
      leaderResponses: [
        JSON.stringify({ schema: "runtime-batch/v1", dispatches: [{ to: "terra", prompt: "Step 1." }] }),
        JSON.stringify({
          schema: "runtime-batch/v1",
          dispatches: [{ to: "terra", prompt: "Step 2.", continuationMode: "continue" }],
        }),
      ],
    });
    await h.startRun();
    await h.completeLeaderTurn();
    assert.equal(h.spawnCalls.length, 1);
    assert.equal(h.spawnCalls[0]?.providerSessionId, undefined);
    const w1 = h.latestWorker()!;
    await h.setWorkerTerminal(w1.dispatchId, w1.runtimeSessionId, {
      outcome: "succeeded",
      stopProof: "proven_stopped",
    });
    await h.completeLeaderTurn();
    assert.equal(h.spawnCalls.length, 2);
    assert.equal(h.spawnCalls[1]?.targetAgentId, "terra");
    assert.equal(h.spawnCalls[1]?.providerSessionId, "prov-terra-1");
    assert.equal(h.degradedEvents.length, 0);
  }

  // 2. Unclean prior terminal or unproven stop + continue => degrades to fresh & emits runtime_session_resume_degraded
  {
    const h = createSquadCoordinatorHarness(t, {
      leaderResponses: [
        JSON.stringify({ schema: "runtime-batch/v1", dispatches: [{ to: "terra", prompt: "Step 1." }] }),
        JSON.stringify({
          schema: "runtime-batch/v1",
          dispatches: [{ to: "terra", prompt: "Step 2.", continuationMode: "continue" }],
        }),
      ],
    });
    await h.startRun();
    await h.completeLeaderTurn();
    const w1 = h.latestWorker()!;
    await h.setWorkerTerminal(w1.dispatchId, w1.runtimeSessionId, { outcome: "cancelled", stopProof: "unproven" });
    await h.completeLeaderTurn();
    assert.equal(h.spawnCalls.length, 2);
    assert.equal(h.spawnCalls[1]?.providerSessionId, undefined);
    assert.equal(h.degradedEvents.length, 1);
    assert.equal(h.degradedEvents[0]?.payload.degradedTo, "fresh");
    assert.equal(h.degradedEvents[0]?.payload.reasonCode, "prior_attempt_not_proven_stopped");
  }

  // 3. Resume spawn failure + continue => emits runtime_session_resume_degraded and retries :fresh
  {
    const h = createSquadCoordinatorHarness(t, {
      leaderResponses: [
        JSON.stringify({ schema: "runtime-batch/v1", dispatches: [{ to: "terra", prompt: "Step 1." }] }),
        JSON.stringify({
          schema: "runtime-batch/v1",
          dispatches: [{ to: "terra", prompt: "Step 2.", continuationMode: "continue" }],
        }),
      ],
      onWorkerSpawn: (payload, attempt) =>
        attempt === 2 && payload.providerSessionId
          ? { outcome: "throw", error: Object.assign(new Error("resume expired"), { code: "runtime_resume_failed" }) }
          : { outcome: "ok" },
    });
    await h.startRun();
    await h.completeLeaderTurn();
    const w1 = h.latestWorker()!;
    await h.setWorkerTerminal(w1.dispatchId, w1.runtimeSessionId, {
      outcome: "succeeded",
      stopProof: "proven_stopped",
    });
    await h.completeLeaderTurn();
    assert.equal(h.spawnCalls.length, 3);
    assert.equal(h.spawnCalls[1]?.providerSessionId, "prov-terra-1");
    assert.equal(h.spawnCalls[2]?.providerSessionId, undefined);
    assert.equal(h.degradedEvents.length, 1);
    assert.equal(h.degradedEvents[0]?.payload.degradedTo, "fresh");
    assert.equal(h.degradedEvents[0]?.payload.reasonCode, "runtime_resume_failed");
  }

  // 4. Cross-employee handoff => carries HandoffPacketV1 and forbids providerSessionId; handoff without prior packet rejects
  {
    const h = createSquadCoordinatorHarness(t, {
      leaderResponses: [
        JSON.stringify({ schema: "runtime-batch/v1", dispatches: [{ to: "terra", prompt: "Step 1." }] }),
        JSON.stringify({
          schema: "runtime-batch/v1",
          dispatches: [{ to: "hydrogen", prompt: "Take over.", continuationMode: "handoff" }],
        }),
      ],
    });
    await h.startRun();
    await h.completeLeaderTurn();
    const w1 = h.latestWorker()!;
    await h.setWorkerTerminal(w1.dispatchId, w1.runtimeSessionId, {
      outcome: "succeeded",
      stopProof: "proven_stopped",
    });
    await h.completeLeaderTurn();
    assert.equal(h.spawnCalls.length, 2);
    assert.equal(h.spawnCalls[1]?.targetAgentId, "hydrogen");
    assert.equal(h.spawnCalls[1]?.providerSessionId, undefined);
    assert.match(String(h.spawnCalls[1]?.prompt), /# HandoffPacketV1/u);

    const hMissing = createSquadCoordinatorHarness(t, {
      leaderResponses: [
        JSON.stringify({
          schema: "runtime-batch/v1",
          dispatches: [{ to: "hydrogen", prompt: "No prior.", continuationMode: "handoff" }],
        }),
      ],
    });
    await hMissing.startRun();
    await hMissing.completeLeaderTurn();
    assert.equal(hMissing.spawnCalls.length, 0);
  }

  // 5. Cross-employee continue without handoff rejects and records degradedTo=handoff
  {
    const hCrossContinue = createSquadCoordinatorHarness(t, {
      leaderResponses: [
        JSON.stringify({ schema: "runtime-batch/v1", dispatches: [{ to: "terra", prompt: "Step 1." }] }),
        JSON.stringify({
          schema: "runtime-batch/v1",
          dispatches: [{ to: "hydrogen", prompt: "Continue terra.", continuationMode: "continue" }],
        }),
      ],
    });
    await hCrossContinue.startRun();
    await hCrossContinue.completeLeaderTurn();
    const w1 = hCrossContinue.latestWorker()!;
    await hCrossContinue.setWorkerTerminal(w1.dispatchId, w1.runtimeSessionId, {
      outcome: "succeeded",
      stopProof: "proven_stopped",
    });
    await hCrossContinue.completeLeaderTurn();
    assert.equal(hCrossContinue.spawnCalls.length, 1);
    assert.equal(hCrossContinue.degradedEvents.length, 1);
    assert.equal(hCrossContinue.degradedEvents[0]?.payload.degradedTo, "handoff");
    assert.equal(hCrossContinue.degradedEvents[0]?.payload.reasonCode, "employee_switched_requires_handoff_packet");
  }
});
