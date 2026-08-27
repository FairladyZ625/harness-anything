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
};

function makeRecoveryFixture(
  rootDir: string,
  options: {
    readonly leaderOutcome: RuntimeSession["outcome"];
    readonly leaderResult?: string;
    readonly workers?: readonly SeedWorker[];
    readonly currentLeaderRuntimeSessionId?: string | null;
    readonly pendingLeaderTriggers?: readonly Readonly<Record<string, unknown>>[];
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
    spawns: JsonObject[] = [];
  let reacquired = 0,
    nextSpawn = 0;

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
    roster: "leader -> sol, terra",
    workers: ["sol", "terra"],
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
    observedWorkerRuntimeSessionIds: [],
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
      readContentBlob: (sha256: string) =>
        sha256 === RESULT_SHA && options.leaderResult !== undefined
          ? new TextEncoder().encode(options.leaderResult)
          : null,
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
          nextSpawn += 1;
          return Promise.resolve({
            ok: true,
            dispatchId: `dispatch_${(100 + nextSpawn).toString(16).padStart(24, "0")}`,
            runtimeSessionId: `runtime-spawn-${nextSpawn}`,
          });
        },
      }),
    }),
    spawns,
    reacquired: () => reacquired,
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
    const fixture = makeRecoveryFixture(rootDir, { leaderOutcome: "succeeded", leaderResult: "not json" });
    await fixture.coordinator.observeOutcome(outcomeEvent(LEADER_SESSION_ID));

    assert.equal(fixture.spawns.length, 1);
    assert.equal(fixture.reacquired(), 1);
    assert.equal(fixture.spawns[0]?.providerSessionId, "provider-leader");
    assert.equal(fixture.spawns[0]?.idempotencyKey, `${SQUAD_RUN_ID}:leader:retry:leader-1`);
    assert.match(String(fixture.spawns[0]?.prompt), /Leader result was not JSON\./u);
    const status = fixture.coordinator.status(SQUAD_RUN_ID);
    assert.equal(status.status, "leader_running");
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
    const fixture = makeRecoveryFixture(rootDir, { leaderOutcome: "failed" });
    await fixture.coordinator.observeOutcome(outcomeEvent(LEADER_SESSION_ID));

    assert.equal(fixture.spawns.length, 1);
    assert.match(String(fixture.spawns[0]?.prompt), /Leader turn leader-1 ended with failed\./u);
    assert.equal(fixture.coordinator.status(SQUAD_RUN_ID).status, "leader_running");
  });
});

test("an empty non-converged plan re-asks the leader instead of failing the run", async () => {
  await withRootDir(async (rootDir) => {
    const fixture = makeRecoveryFixture(rootDir, {
      leaderOutcome: "succeeded",
      leaderResult: JSON.stringify({ schema: "runtime-batch/v1", dispatches: [] }),
    });
    await fixture.coordinator.observeOutcome(outcomeEvent(LEADER_SESSION_ID));

    assert.equal(fixture.spawns.length, 1);
    assert.match(String(fixture.spawns[0]?.prompt), /Leader returned no work and did not declare convergence\./u);
    assert.equal(fixture.coordinator.status(SQUAD_RUN_ID).status, "leader_running");
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
  });
});

test("reconcile resumes a durable leader retry left pending between daemon turns", async () => {
  await withRootDir(async (rootDir) => {
    const fixture = makeRecoveryFixture(rootDir, {
      leaderOutcome: "failed",
      currentLeaderRuntimeSessionId: null,
      pendingLeaderTriggers: [
        { kind: "leader_retry", turnId: "leader-1", reason: "Leader turn leader-1 ended with failed." },
      ],
    });
    await fixture.coordinator.reconcile();

    assert.equal(fixture.spawns.length, 1);
    assert.equal(fixture.coordinator.status(SQUAD_RUN_ID).status, "leader_running");
  });
});
