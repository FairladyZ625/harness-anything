// harness-test-tier: fast
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  ActorIdentity,
  AgentRuntimeEventV1,
  CanonicalEventStore,
  RuntimeSession,
  TaskProjection,
} from "@harness-anything/kernel";
import { makeSquadCoordinator } from "../src/squad-coordinator.ts";
import { appendRuntimeWorkerRecord, dispatchStreamPath, openDispatchStream } from "../src/dispatch-stream.ts";
import type { JsonObject } from "../src/protocol/json-rpc-types.ts";

const SQUAD_RUN_ID = "squad_0123456789abcdef01234567",
  TASK_ID = "task-squad-recovery",
  INSTANCE_ID = "instance-squad",
  LEADER_DISPATCH_ID = "dispatch_000000000000000000000001",
  LEADER_SESSION_ID = "runtime-leader-1",
  SYNTHESIS_REPORT_PATH = `artifacts/reports/${SQUAD_RUN_ID}.md`,
  SYNTHESIS_BODY = "# Squad synthesis\n\nVerified worker outcomes.",
  RESULT_SHA = "1".repeat(64),
  RESULT_REF = `artifact:runtime-result/sha256/${RESULT_SHA}`;

type SeedWorker = {
  readonly workerId: string;
  readonly dispatchId: string;
  readonly runtimeSessionId: string;
  readonly outcome: RuntimeSession["outcome"];
};

type RecoveryFixture = {
  readonly coordinator: ReturnType<typeof makeSquadCoordinator>;
  readonly spawns: JsonObject[];
  readonly cancellations: JsonObject[];
  readonly publications: Array<{
    readonly report: {
      readonly taskId: string;
      readonly squadRunId: string;
      readonly reportPath: string;
      readonly body: string;
      readonly leaderRuntimeSessionId: string;
    };
    readonly binding: unknown;
  }>;
  readonly reacquired: () => number;
  readonly children: Map<string, string>;
  readonly released: string[];
  readonly childLeaseActors: Map<string, ActorIdentity>;
  readonly persistState: (patch: Readonly<Record<string, unknown>>) => void;
  readonly state: () => Readonly<Record<string, unknown>>;
  readonly resetProjection: () => void;
  readonly completeLeader: (runtimeSessionId: string, result: string) => void;
  readonly completeWorker: (
    runtimeSessionId: string,
    result?: string,
    outcome?: "succeeded" | "failed" | "cancelled",
  ) => void;
};

function makeRecoveryFixture(
  rootDir: string,
  options: {
    readonly leaderOutcome: RuntimeSession["outcome"];
    readonly leaderResult?: string;
    readonly leaderTurnBudget: number;
    readonly workers?: readonly SeedWorker[];
    readonly currentLeaderRuntimeSessionId?: string | null;
    readonly pendingLeaderTriggers?: readonly Readonly<Record<string, unknown>>[];
    readonly rejectWorkerOnce?: string;
    readonly pendingChildLeaseActor?: ActorIdentity;
    readonly observedWorkerRuntimeSessionIds?: readonly string[];
    readonly permissionMode?: "bypass" | "workspace-write" | "read-only";
  },
): RecoveryFixture {
  const workers = options.workers ?? [],
    sessions: RuntimeSession[] = [
      runtimeSession(
        LEADER_SESSION_ID,
        options.leaderOutcome,
        options.leaderResult === undefined ? null : RESULT_REF,
        "provider-leader",
      ),
      ...workers.map((worker) =>
        runtimeSession(worker.runtimeSessionId, worker.outcome, null, `provider-${worker.workerId}`),
      ),
    ],
    dispatchBySession = new Map<string, string>([
      [LEADER_SESSION_ID, LEADER_DISPATCH_ID],
      ...workers.map((worker) => [worker.runtimeSessionId, worker.dispatchId] as const),
    ]),
    rows: { squadRunId: string; revision: number; state: Readonly<Record<string, unknown>> }[] = [],
    spawns: JsonObject[] = [],
    cancellations: JsonObject[] = [],
    publications: RecoveryFixture["publications"] = [],
    resultBodies = new Map<string, Uint8Array>(),
    children = new Map<string, string>(),
    released: string[] = [],
    childLeaseActors = new Map<string, ActorIdentity>(),
    sessionTasks = new Map<string, string>([
      [LEADER_SESSION_ID, TASK_ID],
      ...workers.map((worker, index) => [worker.runtimeSessionId, `task-seed-child-${index + 1}`] as const),
    ]),
    receipts = new Map<string, JsonObject>();
  let reacquired = 0,
    nextSpawn = 0,
    nextResult = 2,
    rejectedWorker = false;

  for (const [index, session] of sessions.entries()) {
    const taskId = sessionTasks.get(session.runtimeSessionId)!;
    sessions[index] = { ...session, taskBindings: [{ taskId, executionId: `execution-${taskId}` }] };
  }
  if (options.leaderResult !== undefined) resultBodies.set(RESULT_SHA, new TextEncoder().encode(options.leaderResult));
  for (const [runtimeSessionId, dispatchId] of dispatchBySession)
    openDispatchStream(rootDir, {
      dispatchId,
      taskId: sessionTasks.get(runtimeSessionId)!,
      executionId: `execution-${sessionTasks.get(runtimeSessionId)!}`,
      agentId: workers.find((worker) => worker.runtimeSessionId === runtimeSessionId)?.workerId ?? "leader",
      runtimeSessionId,
      instanceId: INSTANCE_ID,
      startedAt: "2026-08-27T00:00:00.000Z",
    });

  const state = {
    schema: "squad-run/v1",
    squadRunId: SQUAD_RUN_ID,
    stateDispatchId: LEADER_DISPATCH_ID,
    squadId: "core-squad",
    taskId: TASK_ID,
    runtimeInstanceId: INSTANCE_ID,
    cwd: rootDir,
    mission: "Finish the milestone",
    model: null,
    effort: null,
    permissionMode: options.permissionMode ?? "read-only",
    baseSha: "1".repeat(40),
    leaderAgentId: "leader",
    roster: "leader -> sol, terra\nsynthesis -> artifacts/reports/{squadRunId}.md",
    workers: ["sol", "terra"],
    leaderTurnBudget: options.leaderTurnBudget,
    binding: { actor: { principal: { personId: "person-squad" }, executor: null }, source: "local" },
    leaderTurns: [
      {
        turnId: "leader-1",
        trigger: { kind: "initial" },
        dispatchId: LEADER_DISPATCH_ID,
        runtimeSessionId: LEADER_SESSION_ID,
        decision: null,
      },
    ],
    leaderProviderSessionId: null,
    currentLeaderRuntimeSessionId:
      options.currentLeaderRuntimeSessionId === undefined ? LEADER_SESSION_ID : options.currentLeaderRuntimeSessionId,
    workerAttempts: workers.map((worker, index) => ({
      attemptId: `worker-${index + 1}`,
      workerId: worker.workerId,
      leaderTurnId: "leader-previous",
      taskId: sessionTasks.get(worker.runtimeSessionId)!,
      executionId: `execution-${sessionTasks.get(worker.runtimeSessionId)!}`,
      ownedPaths: [],
      ownershipCheck: null,
      dispatchId: worker.dispatchId,
      runtimeSessionId: worker.runtimeSessionId,
      worktree: null,
      rejection: null,
    })),
    observedWorkerRuntimeSessionIds: options.observedWorkerRuntimeSessionIds ?? [],
    workerWaits: [],
    pendingLeaderTriggers: options.pendingLeaderTriggers ?? [],
    phase: options.currentLeaderRuntimeSessionId === null ? "planning" : "leader_running",
    revision: 1,
    error: null,
  } as const;
  appendRuntimeWorkerRecord(rootDir, LEADER_DISPATCH_ID, {
    kind: "squad_run_state",
    squadRunId: SQUAD_RUN_ID,
    revision: state.revision,
    state,
  });

  const projection = {
      read: (taskId: string) => ({
        watermark: 1,
        sourceRevision: 1,
        snapshot: {
          task: { taskId },
          lease: {
            taskId,
            executionId: `execution-${taskId}`,
            phase: "held",
            actor: childLeaseActors.get(taskId) ?? state.binding.actor,
          },
        },
      }),
      readTaskStatuses: () => ({ status: "ready", rows: [], watermark: 1, sourceRevision: 1 }),
      readTaskRuntimeBatch: (query: { readonly taskIds: readonly string[] }) => ({
        status: "ready",
        taskIds: query.taskIds,
        rows: query.taskIds.map((taskId) => ({
          taskId,
          title: "Squad recovery",
          packagePath: `tasks/${taskId}`,
          sessions: sessions.filter((session) => sessionTasks.get(session.runtimeSessionId) === taskId),
        })),
        page: { nextTaskId: null, remainingCount: 0 },
        watermark: 1,
        sourceRevision: 1,
      }),
      readRuntimeDispatch: (runtimeSessionId: string) => {
        const dispatchId = dispatchBySession.get(runtimeSessionId);
        return dispatchId
          ? ({
              type: "runtime_dispatch_requested",
              occurredAt: "2026-08-27T00:00:00.000Z",
              payload: { dispatchId, runtimeSessionId },
            } as Extract<AgentRuntimeEventV1, { type: "runtime_dispatch_requested" }>)
          : null;
      },
      readDocument: () => ({ status: "ready", document: null, watermark: 1, sourceRevision: 1 }),
      squadRunProjectionReady: () => rows.length > 0,
      replaceSquadRuns: (value: typeof rows) => {
        rows.length = 0;
        rows.push(...value);
      },
      markSquadRunProjectionDirty: () => undefined,
      upsertSquadRun: (row: (typeof rows)[number]) => {
        const known = rows.findIndex((candidate) => candidate.squadRunId === row.squadRunId);
        if (known === -1) rows.push(row);
        else if (rows[known]!.revision <= row.revision) rows[known] = row;
      },
      readSquadRun: (squadRunId: string) => rows.find((row) => row.squadRunId === squadRunId) ?? null,
      readSquadRuns: () => rows,
      readRuntimeSession: (runtimeSessionId: string) =>
        sessions.find((session) => session.runtimeSessionId === runtimeSessionId) ?? null,
    } as unknown as TaskProjection,
    store = {
      read: () => ({ schema: "canonical-event-stream/v1", revision: 0, events: [] }),
      readContentBlob: (sha256: string) => resultBodies.get(sha256) ?? null,
    } as CanonicalEventStore;
  return {
    coordinator: makeSquadCoordinator({
      rootDir,
      projection: () => projection,
      store: () => store,
      reacquireTaskLease: (taskId) => {
        assert.deepEqual(
          childLeaseActors.get(taskId) ?? state.binding.actor,
          state.binding.actor,
          "coordinator cannot reacquire a foreign lease",
        );
        reacquired += 1;
        return Promise.resolve();
      },
      releaseTaskLease: async (taskId) => {
        assert.deepEqual(
          childLeaseActors.get(taskId) ?? state.binding.actor,
          state.binding.actor,
          "coordinator cannot release a foreign lease",
        );
        released.push(taskId);
      },
      createChildTask: async (child) => {
        assert.equal(child.parentTaskId, TASK_ID);
        const taskId = children.get(child.key) ?? `task-created-child-${children.size + 1}`;
        children.set(child.key, taskId);
        if (options.pendingChildLeaseActor && !childLeaseActors.has(taskId))
          childLeaseActors.set(taskId, options.pendingChildLeaseActor);
        return taskId;
      },
      recordOwnershipCheck: async () => undefined,
      publishSynthesisReport: (report, binding) => {
        publications.push({ report, binding });
        return Promise.resolve();
      },
      runtimeSpawner: () => ({
        spawn: (payload) => {
          const key = String(payload.idempotencyKey),
            existing = receipts.get(key);
          if (existing) return Promise.resolve(existing);
          spawns.push(payload);
          const holder = childLeaseActors.get(String(payload.taskId));
          if (
            holder &&
            (holder.principal.personId !== state.binding.actor.principal.personId ||
              holder.executor?.id !== `runtime-session:runtime-spawn-${nextSpawn + 1}`)
          )
            return Promise.reject(new Error("runtime_task_lease_required: unrelated runtime holder"));
          if (
            options.rejectWorkerOnce !== undefined &&
            payload.targetAgentId === options.rejectWorkerOnce &&
            !rejectedWorker
          ) {
            rejectedWorker = true;
            return Promise.reject(new Error(`worker ${options.rejectWorkerOnce} rejected`));
          }
          nextSpawn += 1;
          const dispatchId = `dispatch_${(100 + nextSpawn).toString(16).padStart(24, "0")}`,
            runtimeSessionId = `runtime-spawn-${nextSpawn}`;
          dispatchBySession.set(runtimeSessionId, dispatchId);
          const taskId = String(payload.taskId);
          sessionTasks.set(runtimeSessionId, taskId);
          openDispatchStream(rootDir, {
            dispatchId,
            taskId,
            executionId: `execution-${taskId}`,
            agentId: String(payload.targetAgentId ?? "leader"),
            runtimeSessionId,
            instanceId: INSTANCE_ID,
            startedAt: "2026-08-27T00:00:00.000Z",
          });
          sessions.push({
            ...runtimeSession(runtimeSessionId, null, null, "provider-leader"),
            taskBindings: [{ taskId, executionId: `execution-${taskId}` }],
          });
          const receipt = { ok: true, dispatchId, runtimeSessionId };
          receipts.set(key, receipt);
          return Promise.resolve(receipt);
        },
        cancel: (payload) => {
          cancellations.push(payload);
          return Promise.resolve({ ok: true, outcome: "applied" });
        },
      }),
    }),
    spawns,
    cancellations,
    publications,
    reacquired: () => reacquired,
    children,
    released,
    childLeaseActors,
    persistState: (patch) => {
      const current = rows.find((row) => row.squadRunId === SQUAD_RUN_ID)!;
      const next = { ...current.state, ...patch, revision: current.revision + 1 };
      appendRuntimeWorkerRecord(rootDir, LEADER_DISPATCH_ID, {
        kind: "squad_run_state",
        squadRunId: SQUAD_RUN_ID,
        revision: next.revision,
        state: next,
      });
      rows.length = 0;
    },
    state: () => {
      const state = rows.find((row) => row.squadRunId === SQUAD_RUN_ID)?.state;
      assert.ok(state);
      return state;
    },
    resetProjection: () => {
      rows.length = 0;
    },
    completeLeader: (runtimeSessionId, result) => {
      const index = sessions.findIndex((session) => session.runtimeSessionId === runtimeSessionId);
      assert.notEqual(index, -1);
      const sha256 = nextResult.toString(16).padStart(64, "0");
      nextResult += 1;
      resultBodies.set(sha256, new TextEncoder().encode(result));
      sessions[index] = {
        ...runtimeSession(runtimeSessionId, "succeeded", `artifact:runtime-result/sha256/${sha256}`, "provider-leader"),
        taskBindings: sessions[index]!.taskBindings,
      };
    },
    completeWorker: (runtimeSessionId, result, outcome = "succeeded") => {
      const index = sessions.findIndex((session) => session.runtimeSessionId === runtimeSessionId);
      assert.notEqual(index, -1);
      const sha256 = nextResult.toString(16).padStart(64, "0");
      nextResult += 1;
      if (result !== undefined) resultBodies.set(sha256, new TextEncoder().encode(result));
      sessions[index] = {
        ...sessions[index]!,
        liveness: "exited",
        outcome,
        exitCode: outcome === "succeeded" ? 0 : 1,
        resultRef: result === undefined ? null : `artifact:runtime-result/sha256/${sha256}`,
      };
    },
  };
}

function runtimeSession(
  runtimeSessionId: string,
  outcome: RuntimeSession["outcome"],
  resultRef: string | null,
  providerSessionId: string,
): RuntimeSession {
  return {
    runtimeSessionId,
    instanceId: INSTANCE_ID,
    installationId: "installation-squad",
    kindId: "codex",
    definitionSnapshotRef: `artifact:runtime-definition/${runtimeSessionId}`,
    providerSessionId,
    transcriptRef: null,
    launchGeneration: 1,
    liveness: outcome === null ? "live" : "exited",
    attachable: false,
    taskBindings: [],
    outcome,
    exitCode: outcome === null ? null : outcome === "succeeded" ? 0 : 1,
    resultRef,
    lastObservedAt: "2026-08-27T00:01:00.000Z",
  };
}

function outcomeEvent(runtimeSessionId: string) {
  return {
    type: "runtime_session_outcome_observed",
    payload: { runtimeSessionId },
  } as Extract<AgentRuntimeEventV1, { type: "runtime_session_outcome_observed" }>;
}

async function withRootDir(use: (rootDir: string) => Promise<void>): Promise<void> {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-squad-recovery-"));
  try {
    await use(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

test("a malformed leader result re-asks the same leader session instead of failing the run", async () => {
  await withRootDir(async (rootDir) => {
    const fixture = makeRecoveryFixture(rootDir, {
      leaderOutcome: "succeeded",
      leaderResult: "not json",
      leaderTurnBudget: 3,
    });
    await fixture.coordinator.observeOutcome(outcomeEvent(LEADER_SESSION_ID));

    assert.equal(fixture.spawns.length, 1);
    assert.equal(fixture.reacquired(), 2);
    assert.equal(fixture.spawns[0]?.squadId, "core-squad");
    assert.equal(fixture.spawns[0]?.providerSessionId, "provider-leader");
    assert.equal(fixture.spawns[0]?.idempotencyKey, `${SQUAD_RUN_ID}:leader:retry:leader-1`);
    assert.match(String(fixture.spawns[0]?.prompt), /Leader result was not JSON\./u);
    const status = fixture.coordinator.status(SQUAD_RUN_ID);
    assert.equal(status.status, "leader_running", String(status.error));
    assert.equal(status.error, null);
    assert.deepEqual((status.leaders as { trigger: unknown }[])[1]?.trigger, {
      kind: "leader_retry",
      turnId: "leader-1",
      reason: "Leader result was not JSON.",
    });
  });
});

test("a second Squad run for the same Task points to the active run without dispatching", async () => {
  await withRootDir(async (rootDir) => {
    const fixture = makeRecoveryFixture(rootDir, { leaderOutcome: null, leaderTurnBudget: 3 });
    await assert.rejects(
      fixture.coordinator.start(
        {
          squadId: "core-squad",
          runtimeInstanceId: INSTANCE_ID,
          taskId: TASK_ID,
          cwd: { scope: "repo-root" },
        },
        { actor: { principal: { personId: "person-squad" }, executor: null }, source: "local" },
      ),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "squad_run_active" &&
        error.message.includes(SQUAD_RUN_ID),
    );
    assert.equal(fixture.spawns.length, 0);
    assert.equal(fixture.reacquired(), 0);
  });
});

test("a cancelled leader is immediately visible and settles cancellation for the whole Squad run", async () => {
  await withRootDir(async (rootDir) => {
    const fixture = makeRecoveryFixture(rootDir, {
      leaderOutcome: "cancelled",
      leaderTurnBudget: 3,
      workers: [
        {
          workerId: "sol",
          dispatchId: "dispatch_000000000000000000000002",
          runtimeSessionId: "runtime-worker-sol",
          outcome: null,
        },
      ],
    });
    assert.equal(fixture.coordinator.status(SQUAD_RUN_ID).status, "cancelled");

    await fixture.coordinator.observeOutcome(outcomeEvent(LEADER_SESSION_ID));

    assert.equal(fixture.state().phase, "cancelled");
    assert.deepEqual(
      fixture.cancellations.map((payload) => payload.runtimeSessionId),
      [LEADER_SESSION_ID, "runtime-worker-sol"],
    );
    assert.equal(fixture.spawns.length, 0, "leader cancellation must not enter the retry loop");
  });
});

test("a failed leader runtime turn is recorded and re-asked instead of terminating the run", async () => {
  await withRootDir(async (rootDir) => {
    const fixture = makeRecoveryFixture(rootDir, { leaderOutcome: "failed", leaderTurnBudget: 3 });
    await fixture.coordinator.observeOutcome(outcomeEvent(LEADER_SESSION_ID));

    assert.equal(fixture.spawns.length, 1);
    assert.match(String(fixture.spawns[0]?.prompt), /Leader turn leader-1 ended with failed\./u);
    const status = fixture.coordinator.status(SQUAD_RUN_ID);
    assert.equal(status.status, "leader_running", String(status.error));
  });
});

test("an empty runtime batch is rejected with an error visible to the leader", async () => {
  await withRootDir(async (rootDir) => {
    const fixture = makeRecoveryFixture(rootDir, {
      leaderOutcome: "succeeded",
      leaderResult: JSON.stringify({ schema: "runtime-batch/v1", dispatches: [] }),
      leaderTurnBudget: 3,
    });
    await fixture.coordinator.observeOutcome(outcomeEvent(LEADER_SESSION_ID));

    assert.equal(fixture.spawns.length, 1);
    assert.match(String(fixture.spawns[0]?.prompt), /Leader runtime-batch\/v1 dispatches must be a non-empty array\./u);
    const status = fixture.coordinator.status(SQUAD_RUN_ID);
    assert.equal(status.status, "leader_running", String(status.error));
  });
});

test("convergence without a worker publishes the synthesis report", async () => {
  await withRootDir(async (rootDir) => {
    const fixture = makeRecoveryFixture(rootDir, {
      leaderOutcome: "succeeded",
      leaderResult: JSON.stringify({ schema: "squad-decision/v1", action: "converged", report: SYNTHESIS_BODY }),
      leaderTurnBudget: 3,
    });
    await fixture.coordinator.observeOutcome(outcomeEvent(LEADER_SESSION_ID));

    const status = fixture.coordinator.status(SQUAD_RUN_ID);
    assert.equal(status.status, "converged", String(status.error));
    assert.equal(status.error, null);
    assert.equal(fixture.publications.length, 1);
    assert.equal(fixture.publications[0]?.report.body, SYNTHESIS_BODY);
  });
});

test("convergence fails when the leader decision has no synthesis report", async () => {
  await withRootDir(async (rootDir) => {
    const fixture = makeRecoveryFixture(rootDir, {
      leaderOutcome: "succeeded",
      leaderResult: JSON.stringify({ schema: "squad-decision/v1", action: "converged" }),
      leaderTurnBudget: 3,
      workers: [
        {
          workerId: "sol",
          dispatchId: "dispatch_000000000000000000000002",
          runtimeSessionId: "runtime-worker-sol",
          outcome: "succeeded",
        },
      ],
      observedWorkerRuntimeSessionIds: ["runtime-worker-sol"],
    });
    await fixture.coordinator.observeOutcome(outcomeEvent(LEADER_SESSION_ID));

    const status = fixture.coordinator.status(SQUAD_RUN_ID);
    assert.equal(status.status, "failed");
    assert.equal(status.error, "Leader declared convergence without a non-empty synthesis report.");
    assert.equal(fixture.publications.length, 0);
  });
});

test("convergence publishes the decision report for the terminal leader runtime session", async () => {
  await withRootDir(async (rootDir) => {
    const fixture = makeRecoveryFixture(rootDir, {
      leaderOutcome: "succeeded",
      leaderResult: JSON.stringify({ schema: "squad-decision/v1", action: "converged", report: SYNTHESIS_BODY }),
      leaderTurnBudget: 3,
      workers: [
        {
          workerId: "sol",
          dispatchId: "dispatch_000000000000000000000002",
          runtimeSessionId: "runtime-worker-sol",
          outcome: "succeeded",
        },
      ],
      observedWorkerRuntimeSessionIds: ["runtime-worker-sol"],
    });
    await fixture.coordinator.observeOutcome(outcomeEvent(LEADER_SESSION_ID));

    const status = fixture.coordinator.status(SQUAD_RUN_ID);
    assert.equal(status.status, "converged", String(status.error));
    assert.equal(status.error, null);
    assert.deepEqual(fixture.publications, [
      {
        report: {
          taskId: TASK_ID,
          squadRunId: SQUAD_RUN_ID,
          reportPath: SYNTHESIS_REPORT_PATH,
          body: SYNTHESIS_BODY,
          leaderRuntimeSessionId: LEADER_SESSION_ID,
        },
        binding: {
          actor: {
            principal: { personId: "person-squad" },
            executor: { kind: "agent", id: `runtime-session:${LEADER_SESSION_ID}` },
          },
          source: "local",
        },
      },
    ]);
  });
});

test("redispatch of an active worker waits while non-overlapping work still starts", async () => {
  await withRootDir(async (rootDir) => {
    const active = {
        workerId: "sol",
        dispatchId: "dispatch_000000000000000000000002",
        runtimeSessionId: "runtime-worker-sol",
        outcome: null,
      } as const,
      fixture = makeRecoveryFixture(rootDir, {
        leaderOutcome: "succeeded",
        leaderResult: JSON.stringify({
          schema: "runtime-batch/v1",
          dispatches: [
            { to: "sol", prompt: "duplicate work" },
            { to: "terra", prompt: "new work" },
          ],
        }),
        leaderTurnBudget: 3,
        workers: [active],
      });
    await fixture.coordinator.observeOutcome(outcomeEvent(LEADER_SESSION_ID));

    assert.equal(fixture.spawns.length, 1);
    assert.equal(fixture.spawns[0]?.targetAgentId, "terra");
    assert.equal(Object.hasOwn(fixture.spawns[0]!, "runtimeInstanceId"), false);
    assert.equal(Object.hasOwn(fixture.spawns[0]!, "model"), false);
    const status = fixture.coordinator.status(SQUAD_RUN_ID);
    assert.equal(status.status, "workers_running");
    assert.equal(status.error, null);
    assert.deepEqual(
      (status.workers as { readonly workerId: string }[]).map((worker) => worker.workerId),
      ["sol", "terra"],
    );
    const reason = "Worker sol already has running attempt worker-1; waited for its callback instead of redispatching.";
    assert.deepEqual(fixture.state().workerWaits, [
      { kind: "worker_wait", runtimeSessionId: active.runtimeSessionId, reason },
    ]);

    fixture.completeWorker(active.runtimeSessionId);
    await fixture.coordinator.observeOutcome(outcomeEvent(active.runtimeSessionId));
    assert.equal(fixture.spawns.length, 1, "the other child must finish before the callback");
    fixture.completeWorker("runtime-spawn-1");
    await fixture.coordinator.observeOutcome(outcomeEvent("runtime-spawn-1"));
    const resumed = fixture.coordinator.status(SQUAD_RUN_ID);
    assert.deepEqual((resumed.leaders as { readonly trigger: unknown }[])[1]?.trigger, {
      kind: "worker_wait",
      runtimeSessionId: active.runtimeSessionId,
      reason,
    });
    assert.match(String(fixture.spawns[1]?.prompt), /Wait completed: Worker sol already has running attempt worker-1/u);
  });
});

test("reconcile resumes a durable leader retry left pending between daemon turns", async () => {
  await withRootDir(async (rootDir) => {
    const fixture = makeRecoveryFixture(rootDir, {
      leaderOutcome: "failed",
      leaderTurnBudget: 3,
      currentLeaderRuntimeSessionId: null,
      pendingLeaderTriggers: [
        { kind: "leader_retry", turnId: "leader-1", reason: "Leader turn leader-1 ended with failed." },
      ],
    });
    await fixture.coordinator.reconcile();

    assert.equal(fixture.spawns.length, 1);
    const status = fixture.coordinator.status(SQUAD_RUN_ID);
    assert.equal(status.status, "leader_running", String(status.error));
  });
});

test("squad cancel persists a terminal phase before stopping every member and reconcile stays inert", async () => {
  await withRootDir(async (rootDir) => {
    const fixture = makeRecoveryFixture(rootDir, {
      leaderOutcome: null,
      leaderTurnBudget: 3,
      workers: [
        {
          workerId: "sol",
          dispatchId: "dispatch_000000000000000000000002",
          runtimeSessionId: "runtime-worker-sol",
          outcome: null,
        },
      ],
    });
    const streamPath = dispatchStreamPath(rootDir, LEADER_DISPATCH_ID);
    truncateSync(streamPath, 500 * 1024 * 1024 - 1);
    appendFileSync(streamPath, "\n");
    const receipt = await fixture.coordinator.cancel(SQUAD_RUN_ID, {
      actor: { principal: { personId: "person-operator" }, executor: null },
      source: "local",
    });

    assert.equal(receipt.status, "cancelled");
    assert.equal(fixture.state().phase, "cancelled");
    assert.deepEqual(
      fixture.cancellations.map((payload) => payload.runtimeSessionId),
      [LEADER_SESSION_ID, "runtime-worker-sol"],
    );
    fixture.resetProjection();
    await fixture.coordinator.reconcile();
    assert.equal(fixture.coordinator.status(SQUAD_RUN_ID).status, "cancelled");
    assert.equal(fixture.spawns.length, 0, "a durable cancellation must not resume after reconciliation");
  });
});

test("malformed leader results exhaust the declared budget after exactly that many turns", async () => {
  await withRootDir(async (rootDir) => {
    const leaderTurnBudget = 3,
      fixture = makeRecoveryFixture(rootDir, {
        leaderOutcome: "succeeded",
        leaderResult: "not json",
        leaderTurnBudget,
      });
    let runtimeSessionId = LEADER_SESSION_ID;
    for (let completedTurns = 1; completedTurns <= leaderTurnBudget; completedTurns += 1) {
      const previousReacquired = fixture.reacquired();
      await fixture.coordinator.observeOutcome(outcomeEvent(runtimeSessionId));
      const status = fixture.coordinator.status(SQUAD_RUN_ID);
      assert.equal(
        (status.leaders as unknown[]).length,
        completedTurns === leaderTurnBudget ? leaderTurnBudget : completedTurns + 1,
      );
      if (completedTurns === leaderTurnBudget) {
        assert.equal(fixture.reacquired(), previousReacquired, "exhausted budget must not acquire a lease");
        assert.equal(status.status, "failed");
        assert.equal(status.error, `leader turn budget ${leaderTurnBudget} exhausted`);
      } else {
        assert.equal(status.status, "leader_running", String(status.error));
        runtimeSessionId = String(status.currentLeaderRuntimeSessionId);
        fixture.completeLeader(runtimeSessionId, "not json");
      }
    }
    assert.equal(fixture.spawns.length, leaderTurnBudget - 1);
  });
});

test("one callback turn drains more worker outcomes than the leader turn budget", async () => {
  await withRootDir(async (rootDir) => {
    const workers = Array.from({ length: 6 }, (_, index) => ({
        workerId: index % 2 === 0 ? "sol" : "terra",
        dispatchId: `dispatch_${(index + 2).toString(16).padStart(24, "0")}`,
        runtimeSessionId: `runtime-worker-${index + 1}`,
        outcome: null,
      })),
      fixture = makeRecoveryFixture(rootDir, {
        leaderOutcome: null,
        leaderTurnBudget: 3,
        workers,
      });

    for (const worker of workers) {
      fixture.completeWorker(worker.runtimeSessionId);
      await fixture.coordinator.observeOutcome(outcomeEvent(worker.runtimeSessionId));
    }
    let status = fixture.coordinator.status(SQUAD_RUN_ID);
    assert.equal(status.status, "leader_running");
    assert.equal(status.pendingLeaderCallbackCount, workers.length);
    assert.equal(fixture.spawns.length, 0, "callbacks queue while the leader is running");

    fixture.completeLeader(LEADER_SESSION_ID, JSON.stringify({ schema: "squad-decision/v1", action: "waiting" }));
    await fixture.coordinator.observeOutcome(outcomeEvent(LEADER_SESSION_ID));

    status = fixture.coordinator.status(SQUAD_RUN_ID);
    assert.equal(status.status, "leader_running", String(status.error));
    assert.equal(status.pendingLeaderCallbackCount, 0);
    assert.equal((status.leaders as unknown[]).length, 2);
    assert.equal(fixture.spawns.length, 1);
    assert.match(String(fixture.spawns[0]?.prompt), /Merged callback batch: total=6; sources=worker_outcome:6/u);
    for (const [index, worker] of workers.entries())
      assert.match(
        String(fixture.spawns[0]?.prompt),
        new RegExp(`attempt=worker-${index + 1} .*session=${worker.runtimeSessionId} status=succeeded`, "u"),
      );

    const callbackSessionId = String(status.currentLeaderRuntimeSessionId);
    fixture.completeLeader(
      callbackSessionId,
      JSON.stringify({ schema: "squad-decision/v1", action: "converged", report: SYNTHESIS_BODY }),
    );
    await fixture.coordinator.observeOutcome(outcomeEvent(callbackSessionId));

    status = fixture.coordinator.status(SQUAD_RUN_ID);
    assert.equal(status.status, "converged", String(status.error));
    assert.equal((status.leaders as unknown[]).length, 2);
    assert.equal(status.error, null);
  });
});

test("a leader retry remains primary while coalescing queued worker outcomes", async () => {
  await withRootDir(async (rootDir) => {
    const workers = [
        {
          workerId: "sol",
          dispatchId: "dispatch_000000000000000000000002",
          runtimeSessionId: "runtime-worker-sol",
          outcome: null,
        },
        {
          workerId: "terra",
          dispatchId: "dispatch_000000000000000000000003",
          runtimeSessionId: "runtime-worker-terra",
          outcome: null,
        },
      ] as const,
      fixture = makeRecoveryFixture(rootDir, {
        leaderOutcome: "succeeded",
        leaderResult: "not json",
        leaderTurnBudget: 3,
        workers,
      });
    for (const worker of workers) {
      fixture.completeWorker(worker.runtimeSessionId);
      await fixture.coordinator.observeOutcome(outcomeEvent(worker.runtimeSessionId));
    }

    await fixture.coordinator.observeOutcome(outcomeEvent(LEADER_SESSION_ID));

    let status = fixture.coordinator.status(SQUAD_RUN_ID);
    assert.equal(status.status, "leader_running", String(status.error));
    assert.equal(status.pendingLeaderCallbackCount, 0);
    assert.deepEqual((status.leaders as { readonly trigger: unknown }[])[1]?.trigger, {
      kind: "leader_retry",
      turnId: "leader-1",
      reason: "Leader result was not JSON.",
    });
    assert.equal(fixture.spawns[0]?.providerSessionId, "provider-leader");
    assert.equal(fixture.spawns[0]?.idempotencyKey, `${SQUAD_RUN_ID}:leader:retry:leader-1`);
    assert.match(
      String(fixture.spawns[0]?.prompt),
      /Merged callback batch: total=3; sources=leader_retry:1,worker_outcome:2/u,
    );
    assert.match(String(fixture.spawns[0]?.prompt), /Previous turn could not advance: Leader result was not JSON\./u);

    const retrySessionId = String(status.currentLeaderRuntimeSessionId);
    fixture.completeLeader(
      retrySessionId,
      JSON.stringify({ schema: "squad-decision/v1", action: "converged", report: SYNTHESIS_BODY }),
    );
    await fixture.coordinator.observeOutcome(outcomeEvent(retrySessionId));
    status = fixture.coordinator.status(SQUAD_RUN_ID);
    assert.equal(status.status, "converged", String(status.error));
  });
});

test("a rejected worker attempt does not block a later dispatch to the same worker", async () => {
  await withRootDir(async (rootDir) => {
    const plan = JSON.stringify({
        schema: "runtime-batch/v1",
        dispatches: [{ to: "sol", prompt: "try the worker" }],
      }),
      fixture = makeRecoveryFixture(rootDir, {
        leaderOutcome: "succeeded",
        leaderResult: plan,
        leaderTurnBudget: 4,
        rejectWorkerOnce: "sol",
      });
    await fixture.coordinator.observeOutcome(outcomeEvent(LEADER_SESSION_ID));
    const retryLeaderSessionId = String(fixture.coordinator.status(SQUAD_RUN_ID).currentLeaderRuntimeSessionId);
    fixture.completeLeader(retryLeaderSessionId, plan);
    await fixture.coordinator.observeOutcome(outcomeEvent(retryLeaderSessionId));

    const status = fixture.coordinator.status(SQUAD_RUN_ID),
      attempts = status.workers as Array<{
        readonly workerId: string;
        readonly dispatchId: string | null;
        readonly rejection: string | null;
      }>;
    assert.equal(status.status, "workers_running");
    assert.deepEqual(
      attempts.map(({ workerId, dispatchId, rejection }) => ({ workerId, dispatchId, rejection })),
      [
        { workerId: "sol", dispatchId: null, rejection: "worker sol rejected" },
        { workerId: "sol", dispatchId: "dispatch_000000000000000000000066", rejection: null },
      ],
    );
    assert.deepEqual(
      fixture.spawns.map((spawn) => spawn.targetAgentId ?? "leader"),
      ["sol", "leader", "sol"],
    );
  });
});

test("leader callback includes both immutable worker results without report files or truncation", async () => {
  await withRootDir(async (rootDir) => {
    const bodies = ["# First lens\n" + "evidence ".repeat(1100) + "FIRST-END", "# Second lens\nSECOND-EVIDENCE"],
      workers = ["sol", "terra"].map((workerId, index) => ({
        workerId,
        dispatchId: `dispatch_${(index + 2).toString(16).padStart(24, "0")}`,
        runtimeSessionId: `runtime-worker-${workerId}`,
        outcome: null,
      })),
      fixture = makeRecoveryFixture(rootDir, { leaderOutcome: null, leaderTurnBudget: 3, workers });
    for (const [index, worker] of workers.entries()) {
      fixture.completeWorker(worker.runtimeSessionId, bodies[index]);
      await fixture.coordinator.observeOutcome(outcomeEvent(worker.runtimeSessionId));
    }
    fixture.completeLeader(LEADER_SESSION_ID, JSON.stringify({ schema: "squad-decision/v1", action: "waiting" }));
    await fixture.coordinator.observeOutcome(outcomeEvent(LEADER_SESSION_ID));
    assert.equal(fixture.spawns.length, 1);
    const prompt = String(fixture.spawns[0]?.prompt);
    for (const body of bodies) assert.ok(prompt.includes(body), `missing worker body: ${body.slice(0, 20)}`);
    assert.doesNotMatch(prompt, /\[truncated\]/u);
  });
});

const independentPlan = {
  kind: "plan" as const,
  dispatches: [
    { workerId: "sol", prompt: "Implement the parser.", ownedPaths: ["src/parser/"] },
    { workerId: "terra", prompt: "Implement the renderer.", ownedPaths: ["src/renderer/"] },
  ],
};

function workerPlanResult(): string {
  return JSON.stringify({
    schema: "runtime-batch/v1",
    dispatches: independentPlan.dispatches.map(({ workerId, ...plan }) => ({ to: workerId, ...plan })),
  });
}

test("independent child dispatches coalesce duplicate outcomes and projection restart into one leader turn", async () => {
  await withRootDir(async (rootDir) => {
    const fixture = makeRecoveryFixture(rootDir, {
      leaderOutcome: "succeeded",
      leaderResult: workerPlanResult(),
      leaderTurnBudget: 3,
    });
    await fixture.coordinator.observeOutcome(outcomeEvent(LEADER_SESSION_ID));
    assert.equal(fixture.children.size, 2);
    assert.deepEqual(
      fixture.spawns.map((spawn) => spawn.taskId),
      [...fixture.children.values()],
    );
    assert.ok(fixture.spawns.every((spawn) => spawn.taskId !== TASK_ID));
    const attempts = fixture.state().workerAttempts as Array<{
      taskId: string;
      executionId: string;
      runtimeSessionId: string;
    }>;
    assert.equal(new Set(attempts.map((attempt) => attempt.executionId)).size, 2);
    for (const attempt of attempts) assert.equal(attempt.executionId, `execution-${attempt.taskId}`);
    assert.ok(fixture.released.includes(TASK_ID), "fanout must release the parent lease");

    fixture.completeWorker(attempts[0]!.runtimeSessionId);
    await fixture.coordinator.observeOutcome(outcomeEvent(attempts[0]!.runtimeSessionId));
    await fixture.coordinator.observeOutcome(outcomeEvent(attempts[0]!.runtimeSessionId));
    assert.equal(fixture.spawns.length, 2, "first outcome cannot wake the leader while its sibling runs");
    fixture.resetProjection();
    await fixture.coordinator.reconcile();
    assert.equal(fixture.spawns.length, 2);

    fixture.completeWorker(attempts[1]!.runtimeSessionId);
    fixture.resetProjection();
    await fixture.coordinator.reconcile();
    assert.equal(fixture.spawns.length, 3);
    assert.equal(fixture.spawns[2]!.taskId, TASK_ID);
    assert.match(String(fixture.spawns[2]!.prompt), /sources=worker_outcome:2/u);
    for (const attempt of attempts) {
      await fixture.coordinator.observeOutcome(outcomeEvent(attempt.runtimeSessionId));
    }
    fixture.resetProjection();
    await fixture.coordinator.reconcile();
    assert.equal(fixture.spawns.length, 3, "duplicate events and projection rebuild must not add a leader turn");
  });
});

test("one outcome callback drains every child terminal already visible in the same cut", async () => {
  await withRootDir(async (rootDir) => {
    const fixture = makeRecoveryFixture(rootDir, {
      leaderOutcome: "succeeded",
      leaderResult: workerPlanResult(),
      leaderTurnBudget: 3,
    });
    await fixture.coordinator.observeOutcome(outcomeEvent(LEADER_SESSION_ID));
    const attempts = fixture.state().workerAttempts as Array<{ runtimeSessionId: string }>;
    for (const attempt of attempts) fixture.completeWorker(attempt.runtimeSessionId);
    for (const attempt of attempts) await fixture.coordinator.observeOutcome(outcomeEvent(attempt.runtimeSessionId));
    assert.equal(fixture.spawns.length, 3);
    assert.match(String(fixture.spawns[2]!.prompt), /sources=worker_outcome:2/u);
    assert.equal(fixture.coordinator.status(SQUAD_RUN_ID).pendingLeaderCallbackCount, 0);
  });
});

test("reconcile replays a persisted leader plan before any child attempt was recorded", async () => {
  await withRootDir(async (rootDir) => {
    const fixture = makeRecoveryFixture(rootDir, { leaderOutcome: "succeeded", leaderTurnBudget: 3 });
    fixture.coordinator.status(SQUAD_RUN_ID);
    const turns = fixture.state().leaderTurns as Readonly<Record<string, unknown>>[];
    fixture.persistState({
      currentLeaderRuntimeSessionId: null,
      leaderTurns: [{ ...turns[0], decision: independentPlan }],
      phase: "planning",
    });
    await fixture.coordinator.reconcile();
    assert.equal(fixture.children.size, 2);
    assert.equal(fixture.spawns.length, 2);
    fixture.resetProjection();
    await fixture.coordinator.reconcile();
    assert.equal(fixture.children.size, 2);
    assert.equal(fixture.spawns.length, 2);
  });
});

test("accepted child dispatch survives a missing attempt receipt without reacquiring its handed-off lease", async () => {
  await withRootDir(async (rootDir) => {
    const fixture = makeRecoveryFixture(rootDir, {
      leaderOutcome: "succeeded",
      leaderResult: workerPlanResult(),
      leaderTurnBudget: 3,
    });
    await fixture.coordinator.observeOutcome(outcomeEvent(LEADER_SESSION_ID));
    const attempts = fixture.state().workerAttempts as Readonly<Record<string, unknown>>[],
      pending = { ...attempts[1], dispatchId: null, runtimeSessionId: null, executionId: null };
    fixture.persistState({ workerAttempts: [attempts[0], pending] });
    const beforeReacquire = fixture.reacquired();
    await fixture.coordinator.reconcile();
    assert.equal(fixture.children.size, 2, "the same attempt key must reuse its child");
    assert.equal(fixture.spawns.length, 2, "canonical dispatch evidence must restore the missing receipt");
    assert.equal(fixture.reacquired() - beforeReacquire, 1, "only the parent is reacquired for child preparation");
    assert.deepEqual(fixture.state().workerAttempts, attempts);
    fixture.resetProjection();
    await fixture.coordinator.reconcile();
    assert.equal(fixture.spawns.length, 2);
  });
});

test("failed and cancelled child outcomes wake the leader once after the complete batch settles", async () => {
  await withRootDir(async (rootDir) => {
    const fixture = makeRecoveryFixture(rootDir, {
      leaderOutcome: "succeeded",
      leaderResult: workerPlanResult(),
      leaderTurnBudget: 3,
    });
    await fixture.coordinator.observeOutcome(outcomeEvent(LEADER_SESSION_ID));
    fixture.completeWorker("runtime-spawn-1", "Parser could not complete.", "failed");
    await fixture.coordinator.observeOutcome(outcomeEvent("runtime-spawn-1"));
    assert.equal(fixture.spawns.length, 2);
    fixture.completeWorker("runtime-spawn-2", "Renderer cancelled.", "cancelled");
    await fixture.coordinator.observeOutcome(outcomeEvent("runtime-spawn-2"));
    assert.equal(fixture.spawns.length, 3);
    assert.match(String(fixture.spawns[2]!.prompt), /status=failed/u);
    assert.match(String(fixture.spawns[2]!.prompt), /status=cancelled/u);
    fixture.resetProjection();
    await fixture.coordinator.reconcile();
    assert.equal(fixture.spawns.length, 3);
  });
});

for (const matchingRuntime of [true, false]) {
  test(`pending child handoff ${matchingRuntime ? "resumes its runtime" : "preserves an unrelated holder"}`, async () => {
    await withRootDir(async (rootDir) => {
      const actor: ActorIdentity = {
          principal: { personId: "person-squad" },
          executor: {
            kind: "agent",
            id: `runtime-session:${matchingRuntime ? "runtime-spawn-1" : "other-runtime"}`,
          },
        },
        fixture = makeRecoveryFixture(rootDir, {
          leaderOutcome: "succeeded",
          leaderTurnBudget: 3,
          pendingChildLeaseActor: actor,
        });
      fixture.coordinator.status(SQUAD_RUN_ID);
      const turns = fixture.state().leaderTurns as Readonly<Record<string, unknown>>[];
      fixture.persistState({
        currentLeaderRuntimeSessionId: null,
        leaderTurns: [{ ...turns[0], decision: { ...independentPlan, dispatches: [independentPlan.dispatches[0]] } }],
        phase: "planning",
      });
      await fixture.coordinator.reconcile();
      const taskId = [...fixture.children.values()][0]!,
        attempt = (fixture.state().workerAttempts as Readonly<Record<string, unknown>>[])[0]!;
      assert.equal(fixture.children.size, 1);
      assert.equal(fixture.spawns[0]!.taskId, taskId, "existing lease must reach runtime admission");
      assert.deepEqual(fixture.childLeaseActors.get(taskId), actor);
      assert.ok(!fixture.released.includes(taskId), "coordinator must not release a handed-off child lease");
      if (matchingRuntime) {
        assert.equal(attempt.runtimeSessionId, "runtime-spawn-1");
        assert.equal(attempt.rejection, null);
        assert.equal(fixture.reacquired(), 1, "only parent preparation can reacquire here");
        fixture.resetProjection();
        await fixture.coordinator.reconcile();
        assert.equal(fixture.spawns.length, 1, "resumed child is dispatched exactly once");
      } else {
        assert.equal(attempt.runtimeSessionId, null);
        assert.match(String(attempt.rejection), /runtime_task_lease_required: unrelated runtime holder/u);
        assert.equal(fixture.spawns[1]!.taskId, TASK_ID, "leader receives the rejection");
      }
    });
  });
}
