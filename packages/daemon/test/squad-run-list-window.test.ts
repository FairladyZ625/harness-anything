// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { type RuntimeSession, type TaskProjection } from "../../kernel/src/index.ts";
import { makeSquadCoordinator } from "../src/squad-coordinator.ts";
import { appendRuntimeWorkerRecord, openDispatchStream } from "../src/dispatch-stream.ts";
import { validateSquadRunsList } from "../src/squad-run-contract.ts";

// 固定「现在」:窗口断言只看相对时间,不依赖真实时钟。
const NOW = "2026-08-27T12:00:00.000Z",
  DAY = 86_400_000,
  sinceAgo = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();

type SeedOptions = {
  readonly squadRunId: string;
  readonly phase: "planning" | "leader_running" | "workers_running" | "converged" | "failed";
  readonly updatedAt?: string;
  readonly leaderSessionId?: string;
  readonly workerSessionId?: string;
};

function seedSquadRun(rootDir: string, options: SeedOptions): string {
  const stateDispatchId = `dispatch_${options.squadRunId.slice(6)}`;
  openDispatchStream(rootDir, {
    dispatchId: stateDispatchId,
    taskId: "task-squad",
    executionId: "execution-squad",
    runtimeSessionId: "runtime-owner",
    instanceId: "instance-squad",
    startedAt: "2026-08-27T11:00:00.000Z",
  });
  appendRuntimeWorkerRecord(rootDir, stateDispatchId, {
    kind: "squad_run_state",
    squadRunId: options.squadRunId,
    revision: 3,
    state: {
      schema: "squad-run/v1",
      squadRunId: options.squadRunId,
      stateDispatchId,
      squadId: "core-squad",
      taskId: "task-squad",
      runtimeInstanceId: "instance-squad",
      cwd: rootDir,
      mission: "window filter witness",
      model: null,
      effort: null,
      leaderAgentId: "terra",
      roster: "terra -> sol",
      workers: ["sol"],
      binding: { actor: { principal: { personId: "person-squad" }, executor: null }, source: "local" },
      leaderTurns: options.leaderSessionId
        ? [
            {
              turnId: "leader-1",
              trigger: { kind: "initial" },
              dispatchId: stateDispatchId,
              runtimeSessionId: options.leaderSessionId,
              decision: { kind: "converged" },
            },
          ]
        : [],
      leaderProviderSessionId: null,
      currentLeaderRuntimeSessionId: null,
      workerAttempts: options.workerSessionId
        ? [
            {
              attemptId: "worker-1",
              workerId: "sol",
              dispatchId: null,
              runtimeSessionId: options.workerSessionId,
              rejection: null,
            },
          ]
        : [],
      observedWorkerRuntimeSessionIds: [],
      pendingLeaderTriggers: [],
      phase: options.phase,
      revision: 3,
      error: null,
      ...(options.updatedAt === undefined ? {} : { updatedAt: options.updatedAt }),
    },
  });
  return stateDispatchId;
}

function session(runtimeSessionId: string, lastObservedAt: string): RuntimeSession {
  return {
    runtimeSessionId,
    instanceId: "instance-squad",
    installationId: "installation-squad",
    kindId: "codex",
    definitionSnapshotRef: "artifact:runtime-definition/squad",
    providerSessionId: null,
    transcriptRef: null,
    launchGeneration: 1,
    liveness: "exited",
    attachable: false,
    taskBindings: [],
    outcome: "succeeded",
    exitCode: 0,
    resultRef: null,
    lastObservedAt,
  };
}

/** 只给 list/readStates 走到的读面装桩:member 会话按需可解析或恒缺失。 */
function projectionWith(sessions: readonly RuntimeSession[]): TaskProjection {
  const rows: { squadRunId: string; revision: number; state: unknown }[] = [];
  return {
    readTaskStatuses: () => ({ status: "ready", rows: [], watermark: 1, sourceRevision: 1 }),
    squadRunProjectionReady: () => rows.length > 0,
    replaceSquadRuns: (value: typeof rows) => {
      rows.length = 0;
      rows.push(...value);
    },
    upsertSquadRun: (row: (typeof rows)[number]) => {
      const known = rows.findIndex((candidate) => candidate.squadRunId === row.squadRunId);
      if (known >= 0 && rows[known]!.revision > row.revision) return;
      if (known >= 0) rows[known] = row;
      else rows.push(row);
    },
    markSquadRunProjectionDirty: () => undefined,
    readSquadRuns: () => rows,
    readSquadRun: (squadRunId: string) => rows.find((row) => row.squadRunId === squadRunId) ?? null,
    readRuntimeSession: (runtimeSessionId: string) =>
      sessions.find((candidate) => candidate.runtimeSessionId === runtimeSessionId) ?? null,
  } as unknown as TaskProjection;
}

function coordinator(rootDir: string, sessions: readonly RuntimeSession[]) {
  const projection = projectionWith(sessions);
  return {
    coordinator: makeSquadCoordinator({
      rootDir,
      projection: () => projection,
      store: () => {
        throw new Error("store is not exercised by the list window");
      },
      runtimeSpawner: () => {
        throw new Error("runtime spawner is not exercised by the list window");
      },
    }),
    projection,
  };
}

function withRootDir(use: (rootDir: string) => void): void {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-squad-window-"));
  try {
    use(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

test("a terminal run whose member sessions are missing still passes a window covering its last state transition", () => {
  withRootDir((rootDir) => {
    seedSquadRun(rootDir, {
      squadRunId: "squad_0123456789abcdef01234567",
      phase: "converged",
      updatedAt: "2026-08-27T11:55:00.000Z",
      leaderSessionId: "runtime-leader",
      workerSessionId: "runtime-worker",
    });
    // 投影里没有任何成员会话行(会话未孵化/已被裁剪):唯一活动证据是 run 自身的状态落盘。
    const { coordinator: squad } = coordinator(rootDir, []);
    const listed = squad.list({ since: sinceAgo(DAY) });
    assert.deepEqual(listed.totals, { runs: 1 });
    assert.equal(listed.runs[0]?.latestActivityAt, "2026-08-27T11:55:00.000Z");
    assert.deepEqual(validateSquadRunsList(listed), []);
  });
});

test("a terminal run outside the window stays hidden even without member sessions", () => {
  withRootDir((rootDir) => {
    seedSquadRun(rootDir, {
      squadRunId: "squad_0123456789abcdef01234567",
      phase: "converged",
      updatedAt: "2026-08-20T11:55:00.000Z",
    });
    const { coordinator: squad } = coordinator(rootDir, []);
    assert.deepEqual(squad.list({ since: sinceAgo(DAY) }).totals, { runs: 0 });
    assert.deepEqual(squad.list({ since: sinceAgo(30 * DAY) }).totals, { runs: 1 });
  });
});

test("member session activity later than the last transition wins as latestActivityAt", () => {
  withRootDir((rootDir) => {
    seedSquadRun(rootDir, {
      squadRunId: "squad_0123456789abcdef01234567",
      phase: "converged",
      updatedAt: "2026-08-27T10:00:00.000Z",
      leaderSessionId: "runtime-leader",
      workerSessionId: "runtime-worker",
    });
    const { coordinator: squad } = coordinator(rootDir, [
      session("runtime-leader", "2026-08-27T11:50:00.000Z"),
      session("runtime-worker", "2026-08-27T11:55:00.000Z"),
    ]);
    const listed = squad.list({ since: sinceAgo(DAY) });
    assert.deepEqual(listed.totals, { runs: 1 });
    assert.equal(listed.runs[0]?.latestActivityAt, "2026-08-27T11:55:00.000Z");
  });
});

test("active runs always pass the window and a missing since lists every run", () => {
  withRootDir((rootDir) => {
    seedSquadRun(rootDir, {
      squadRunId: "squad_0123456789abcdef01234567",
      phase: "workers_running",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    seedSquadRun(rootDir, {
      squadRunId: "squad_0123456789abcdef99887766",
      phase: "failed",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    const { coordinator: squad } = coordinator(rootDir, []);
    assert.deepEqual(squad.list({ since: sinceAgo(DAY) }).totals, { runs: 1 });
    assert.deepEqual(squad.list({}).totals, { runs: 2 });
  });
});

test("the window compares instants, so a second-precision stamp does not sneak past a millisecond cutoff", () => {
  withRootDir((rootDir) => {
    seedSquadRun(rootDir, {
      squadRunId: "squad_0123456789abcdef01234567",
      phase: "converged",
      updatedAt: "2026-08-27T00:00:00Z",
    });
    const { coordinator: squad } = coordinator(rootDir, []);
    // 字典序里 "…00Z" > "…00.000Z"/"…00.500Z"('Z' > '.'),活动在 .000、截点在 .500
    // 时必须按瞬值判为窗外。
    assert.deepEqual(squad.list({ since: "2026-08-27T00:00:00.500Z" }).totals, { runs: 0 });
    assert.deepEqual(squad.list({ since: "2026-08-27T00:00:00.000Z" }).totals, { runs: 1 });
  });
});

test("a persisted transition stamps its own activity time", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-squad-window-"));
  try {
    seedSquadRun(rootDir, {
      squadRunId: "squad_0123456789abcdef01234567",
      phase: "workers_running",
      workerSessionId: "runtime-worker",
    });
    const { coordinator: squad } = coordinator(rootDir, []);
    const before = Date.now();
    // observeOutcome 是真实写路径:worker 结算回调 → continueWorker → writeState 落盘。
    await squad.observeOutcome({
      schema: "agent-runtime-event/v1",
      eventId: "event-outcome",
      workspaceRevision: 4,
      opId: "op-outcome",
      actor: { principal: { personId: "person-squad" }, executor: null },
      source: "local",
      occurredAt: new Date().toISOString(),
      type: "runtime_session_outcome_observed",
      payload: { runtimeSessionId: "runtime-worker", outcome: "succeeded", exitCode: 0, resultRef: null },
    } as Parameters<typeof squad.observeOutcome>[0]);
    const stamp = squad.list({}).runs[0]?.latestActivityAt;
    assert.notEqual(stamp, "1970-01-01T00:00:00.000Z");
    assert.ok(stamp !== undefined && Date.parse(stamp) >= before, `transition stamp ${stamp} predates the write`);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
