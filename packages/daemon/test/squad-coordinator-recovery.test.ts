// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  AgentRuntimeEventV1,
  CanonicalEventStore,
  RuntimeSession,
  TaskProjection,
} from "../../kernel/src/index.ts";
import { makeSquadCoordinator } from "../src/squad-coordinator.ts";
import { appendRuntimeWorkerRecord, openDispatchStream } from "../src/dispatch-stream.ts";
import type { JsonObject } from "../src/protocol/json-rpc-types.ts";

const SQUAD_RUN_ID = "squad_0123456789abcdef01234567",
  TASK_ID = "task-squad-recovery",
  INSTANCE_ID = "instance-squad",
  LEADER_DISPATCH_ID = "dispatch_000000000000000000000001",
  LEADER_SESSION_ID = "runtime-leader-1",
  SYNTHESIS_REPORT_PATH = `artifacts/reports/${SQUAD_RUN_ID}.md`,
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
  readonly reacquired: () => number;
  readonly state: () => Readonly<Record<string, unknown>>;
  readonly completeLeader: (runtimeSessionId: string, result: string) => void;
  readonly completeWorker: (runtimeSessionId: string) => void;
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
    readonly leaderReport?: boolean;
    readonly mirrorLeaderReport?: boolean;
    readonly observedWorkerRuntimeSessionIds?: readonly string[];
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
    resultBodies = new Map<string, Uint8Array>(),
    reportLogicalPath = `tasks/${TASK_ID}/${SYNTHESIS_REPORT_PATH}`,
    reportDocument = options.leaderReport
      ? {
          path: reportLogicalPath,
          blobSha256: "a".repeat(64),
          body: "# Squad synthesis\n\nVerified worker outcomes.",
          size: 44,
          mediaType: "text/markdown",
          policyId: "markdown-body-replaceable/v1",
          workspaceRevision: 2,
        }
      : null,
    reportEvent = options.leaderReport
      ? {
          schema: "doc-event/v1",
          eventId: "event-squad-synthesis",
          workspaceRevision: 2,
          opId: "op-squad-synthesis",
          type: "documents_written",
          actor: {
            principal: { personId: "person-squad" },
            executor: { kind: "agent", id: `runtime-session:${LEADER_SESSION_ID}` },
          },
          source: "local",
          occurredAt: "2026-08-27T00:00:30.000Z",
          payload: {
            executionId: "execution-squad",
            baseLedgerSha: { repoId: "squad-recovery", revision: 1, headDigest: `sha256:${"b".repeat(64)}` },
            changes: [
              {
                path: reportLogicalPath,
                baseBlobSha256: null,
                candidate: {
                  sha256: reportDocument!.blobSha256,
                  size: reportDocument!.size,
                  mediaType: "text/markdown",
                },
                policyId: reportDocument!.policyId,
                regionProofs: [],
              },
            ],
          },
        }
      : null;
  const mirrorReportEvent =
      options.mirrorLeaderReport && reportEvent
        ? {
            ...reportEvent,
            eventId: "event-squad-synthesis-mirror",
            workspaceRevision: 3,
            opId: "op-squad-synthesis-mirror",
            actor: {
              principal: { personId: "person-squad" },
              executor: { kind: "agent" as const, id: "runtime-session:unrelated-observer" },
            },
          }
        : null,
    reportEvents = [reportEvent, mirrorReportEvent].filter((event) => event !== null);
  let reacquired = 0,
    nextSpawn = 0,
    nextResult = 2,
    rejectedWorker = false;

  if (options.leaderResult !== undefined) resultBodies.set(RESULT_SHA, new TextEncoder().encode(options.leaderResult));
  if (reportDocument !== null)
    resultBodies.set(reportDocument.blobSha256, new TextEncoder().encode(reportDocument.body));

  for (const [runtimeSessionId, dispatchId] of dispatchBySession)
    openDispatchStream(rootDir, {
      dispatchId,
      taskId: TASK_ID,
      executionId: "execution-squad",
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
      dispatchId: worker.dispatchId,
      runtimeSessionId: worker.runtimeSessionId,
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
      readTaskStatuses: () => ({ status: "ready", rows: [], watermark: 1, sourceRevision: 1 }),
      readTaskRuntimeBatch: (query: { readonly taskIds: readonly string[] }) => ({
        status: "ready",
        taskIds: query.taskIds,
        rows: query.taskIds.map((taskId) => ({
          taskId,
          title: "Squad recovery",
          packagePath: `tasks/${taskId}`,
          sessions,
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
      read: () => ({
        schema: "canonical-event-stream/v1",
        revision: reportEvents.at(-1)?.workspaceRevision ?? 0,
        events: reportEvents,
      }),
      readContentBlob: (sha256: string) => resultBodies.get(sha256) ?? null,
    } as CanonicalEventStore;
  return {
    coordinator: makeSquadCoordinator({
      rootDir,
      projection: () => projection,
      store: () => store,
      reacquireTaskLease: () => {
        reacquired += 1;
        return Promise.resolve();
      },
      runtimeSpawner: () => ({
        spawn: (payload) => {
          spawns.push(payload);
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
          openDispatchStream(rootDir, {
            dispatchId,
            taskId: TASK_ID,
            executionId: "execution-squad",
            runtimeSessionId,
            instanceId: INSTANCE_ID,
            startedAt: "2026-08-27T00:00:00.000Z",
          });
          sessions.push(runtimeSession(runtimeSessionId, null, null, "provider-leader"));
          return Promise.resolve({ ok: true, dispatchId, runtimeSessionId });
        },
      }),
    }),
    spawns,
    reacquired: () => reacquired,
    state: () => {
      const state = rows.find((row) => row.squadRunId === SQUAD_RUN_ID)?.state;
      assert.ok(state);
      return state;
    },
    completeLeader: (runtimeSessionId, result) => {
      const index = sessions.findIndex((session) => session.runtimeSessionId === runtimeSessionId);
      assert.notEqual(index, -1);
      const sha256 = nextResult.toString(16).padStart(64, "0");
      nextResult += 1;
      resultBodies.set(sha256, new TextEncoder().encode(result));
      sessions[index] = runtimeSession(
        runtimeSessionId,
        "succeeded",
        `artifact:runtime-result/sha256/${sha256}`,
        "provider-leader",
      );
    },
    completeWorker: (runtimeSessionId) => {
      const index = sessions.findIndex((session) => session.runtimeSessionId === runtimeSessionId);
      assert.notEqual(index, -1);
      sessions[index] = { ...sessions[index]!, liveness: "exited", outcome: "succeeded", exitCode: 0 };
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
    assert.equal(fixture.reacquired(), 1);
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

test("convergence fails when no worker dispatch reached a terminal state", async () => {
  await withRootDir(async (rootDir) => {
    const fixture = makeRecoveryFixture(rootDir, {
      leaderOutcome: "succeeded",
      leaderResult: JSON.stringify({ schema: "squad-decision/v1", action: "converged" }),
      leaderTurnBudget: 3,
      leaderReport: true,
    });
    await fixture.coordinator.observeOutcome(outcomeEvent(LEADER_SESSION_ID));

    const status = fixture.coordinator.status(SQUAD_RUN_ID);
    assert.equal(status.status, "failed");
    assert.equal(status.error, "Leader declared convergence without a terminal worker dispatch.");
  });
});

test("convergence fails when the leader did not author the roster-declared synthesis report", async () => {
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
    assert.equal(
      status.error,
      `Leader declared convergence without leader-authored synthesis report ${SYNTHESIS_REPORT_PATH}.`,
    );
  });
});

test("convergence preserves leader authorship when a later observer mirrors the current report blob", async () => {
  await withRootDir(async (rootDir) => {
    const fixture = makeRecoveryFixture(rootDir, {
      leaderOutcome: "succeeded",
      leaderResult: JSON.stringify({ schema: "squad-decision/v1", action: "converged" }),
      leaderTurnBudget: 3,
      leaderReport: true,
      mirrorLeaderReport: true,
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
            { instance: INSTANCE_ID, to: "sol", prompt: "duplicate work" },
            { instance: INSTANCE_ID, to: "terra", prompt: "new work" },
          ],
        }),
        leaderTurnBudget: 3,
        workers: [active],
      });
    await fixture.coordinator.observeOutcome(outcomeEvent(LEADER_SESSION_ID));

    assert.equal(fixture.spawns.length, 1);
    assert.equal(fixture.spawns[0]?.targetAgentId, "terra");
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
      await fixture.coordinator.observeOutcome(outcomeEvent(runtimeSessionId));
      const status = fixture.coordinator.status(SQUAD_RUN_ID);
      assert.equal(
        (status.leaders as unknown[]).length,
        completedTurns === leaderTurnBudget ? leaderTurnBudget : completedTurns + 1,
      );
      if (completedTurns === leaderTurnBudget) {
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

test("a rejected worker attempt does not block a later dispatch to the same worker", async () => {
  await withRootDir(async (rootDir) => {
    const plan = JSON.stringify({
        schema: "runtime-batch/v1",
        dispatches: [{ instance: INSTANCE_ID, to: "sol", prompt: "try the worker" }],
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
