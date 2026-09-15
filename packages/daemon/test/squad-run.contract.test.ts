// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { type CanonicalEventStore, type RuntimeSession, type TaskProjection } from "../../kernel/src/index.ts";
import { appendRuntimeWorkerRecord, openDispatchStream } from "../src/dispatch-stream.ts";
import { daemonGuiReadMethods, validateDaemonRpcCall } from "../src/protocol/daemon-protocol.contract.ts";
import { parseDaemonGuiReadResult } from "../src/protocol/gui-result-validation.ts";
import type { JsonObject } from "../src/protocol/json-rpc-types.ts";
import { makeSquadCoordinator } from "../src/squad-coordinator.ts";
import {
  serializeSquadRunRead,
  serializeSquadRunsList,
  validateSquadRunRead,
  validateSquadRunsList,
} from "../src/squad-run-contract.ts";

const summary = {
  squadRunId: "squad_0123456789abcdef01234567",
  squadId: "core-squad",
  taskId: "task-runtime",
  mission: "Review the runtime read model",
  phase: "leader_running" as const,
  leaderTurnCount: 2,
  workerAttemptCount: 1,
  runningCount: 1,
  latestActivityAt: "2026-08-26T00:00:00.000Z",
};
const list = {
  ok: true as const,
  status: "ready" as const,
  runs: [summary],
  totals: { runs: 1 },
  truncated: false,
  watermark: 42,
  sourceRevision: 42,
};
const detail = {
  ok: true as const,
  status: "ready" as const,
  run: {
    squadRunId: "squad_0123456789abcdef01234567",
    squadId: "core-squad",
    taskId: "task-runtime",
    mission: "Review the runtime read model",
    phase: "converged" as const,
    error: null,
    currentLeaderRuntimeSessionId: null,
    leaderTurns: [
      {
        turnId: "leader-1",
        trigger: { kind: "initial" },
        dispatchId: "dispatch_000000000000000000000001",
        runtimeSessionId: "runtime-leader",
        decision: { kind: "plan", dispatchCount: 1 },
        resultText: '{"schema":"runtime-batch/v1","dispatches":[{"to":"terra","prompt":"go"}]}',
        status: "succeeded" as const,
        startedAt: "2026-08-26T00:00:00.000Z",
        endedAt: "2026-08-26T00:05:00.000Z",
        tokenUsage: { input: 120, output: 30 },
        toolCallCount: 4,
        compacted: true,
      },
      {
        turnId: "leader-2",
        trigger: { kind: "worker_outcome", runtimeSessionId: "runtime-worker-1" },
        dispatchId: "dispatch_000000000000000000000002",
        runtimeSessionId: "runtime-leader",
        decision: { kind: "converged" },
        resultText: null,
        status: null,
        startedAt: null,
        endedAt: null,
        tokenUsage: { input: 0, output: 0 },
        toolCallCount: 0,
        compacted: false,
      },
      {
        turnId: "leader-3",
        trigger: {
          kind: "leader_retry",
          turnId: "leader-2",
          reason: "Leader result was not JSON.",
        },
        dispatchId: "dispatch_000000000000000000000004",
        runtimeSessionId: "runtime-leader-retry",
        decision: null,
        resultText: null,
        status: "running" as const,
        startedAt: "2026-08-26T00:10:00.000Z",
        endedAt: null,
        tokenUsage: { input: 0, output: 0 },
        toolCallCount: 0,
        compacted: false,
      },
      {
        turnId: "leader-4",
        trigger: {
          kind: "worker_wait",
          runtimeSessionId: "runtime-worker-1",
          reason: "Worker terra was already running; waited for its callback instead of redispatching.",
        },
        dispatchId: "dispatch_000000000000000000000005",
        runtimeSessionId: "runtime-leader-wait",
        decision: null,
        resultText: null,
        status: "running" as const,
        startedAt: "2026-08-26T00:11:00.000Z",
        endedAt: null,
        tokenUsage: { input: 0, output: 0 },
        toolCallCount: 0,
        compacted: false,
      },
    ],
    workerAttempts: [
      {
        attemptId: "worker-1",
        workerId: "terra",
        leaderTurnId: "leader-1",
        dispatchId: "dispatch_000000000000000000000003",
        runtimeSessionId: "runtime-worker-1",
        rejection: null,
        status: "succeeded" as const,
        startedAt: "2026-08-26T00:06:00.000Z",
        endedAt: "2026-08-26T00:09:00.000Z",
        tokenUsage: { input: 80, output: 20 },
        toolCallCount: 2,
        compacted: false,
      },
      {
        attemptId: "worker-2",
        workerId: "sol",
        leaderTurnId: "leader-1",
        dispatchId: null,
        runtimeSessionId: null,
        rejection: "Runtime dispatch was rejected.",
        status: null,
        startedAt: null,
        endedAt: null,
        tokenUsage: { input: 0, output: 0 },
        toolCallCount: 0,
        compacted: false,
      },
    ],
  },
  watermark: 42,
  sourceRevision: 42,
};

test("squad run list facet is registered and rejects malformed bounds", () => {
  assert.deepEqual(
    daemonGuiReadMethods.filter(({ method }) => method.startsWith("repo.squad.run")).map(({ method }) => method),
    ["repo.squad.runs.list", "repo.squad.run.read"],
  );
  const validate = (method: string, payload: Record<string, unknown>) =>
    validateDaemonRpcCall({ method, params: { repo: { repoId: "runtime-contract" }, payload } });
  assert.deepEqual(
    validate("repo.squad.runs.list", {
      since: "2026-08-25T00:00:00.000Z",
      query: "core running",
      limit: 50,
    }),
    [],
  );
  assert.notDeepEqual(validate("repo.squad.runs.list", { since: "yesterday" }), []);
  assert.notDeepEqual(validate("repo.squad.runs.list", { limit: 1_001 }), []);
  assert.notDeepEqual(validate("repo.squad.runs.list", { cursor: "retired" }), []);
});

test("squad run read facet requires the exact squad run handle", () => {
  const validate = (payload: Record<string, unknown>) =>
    validateDaemonRpcCall({
      method: "repo.squad.run.read",
      params: { repo: { repoId: "runtime-contract" }, payload },
    });
  assert.deepEqual(validate({ squadRunId: "squad_0123456789abcdef01234567" }), []);
  assert.notDeepEqual(validate({ squadRunId: "squad-short" }), []);
  assert.notDeepEqual(validate({ squadRunId: "squad_0123456789ABCDEF01234567" }), []);
  assert.notDeepEqual(validate({}), []);
  assert.notDeepEqual(validate({ squadRunId: "squad_0123456789abcdef01234567", extra: true }), []);
});

test("squad run list validator locks the redacted wire shape", () => {
  assert.deepEqual(validateSquadRunsList(list), []);
  assert.equal(parseDaemonGuiReadResult("repo.squad.runs.list", list), list);
  assert.equal(serializeSquadRunsList(list), `${JSON.stringify(list)}\n`);
  assert.notDeepEqual(validateSquadRunsList({ ...list, token: "secret" }), []);
});

test("squad run read validator locks the orchestration-flow wire shape", () => {
  assert.deepEqual(validateSquadRunRead(detail), []);
  assert.equal(parseDaemonGuiReadResult("repo.squad.run.read", detail), detail);
  assert.equal(serializeSquadRunRead(detail), `${JSON.stringify(detail)}\n`);
  assert.notDeepEqual(validateSquadRunRead({ ...detail, token: "secret" }), []);
  // 台账行缺失(leader 轮次无对应派工)必须以 null 呈现,不得伪造状态。
  assert.deepEqual(
    validateSquadRunRead({
      ...detail,
      run: {
        ...detail.run,
        leaderTurns: detail.run.leaderTurns.map((turn: { readonly status: string | null }) => ({
          ...turn,
          status: turn.status === null ? "running" : turn.status,
        })),
      },
    }),
    [],
  );
  assert.notDeepEqual(
    validateSquadRunRead({
      ...detail,
      run: {
        ...detail.run,
        leaderTurns: detail.run.leaderTurns.map((turn: object) => ({ ...turn, status: "expired" })),
      },
    }),
    [],
  );
  assert.notDeepEqual(
    validateSquadRunRead({
      ...detail,
      run: {
        ...detail.run,
        leaderTurns: detail.run.leaderTurns.map((turn: object) => ({ ...turn, decision: { kind: "unknown" } })),
      },
    }),
    [],
  );
  // 扇出树的父子边与 receipt 原文是锁死的 wire 字段:缺字段、null 或错类型都不得过。
  assert.notDeepEqual(
    validateSquadRunRead({
      ...detail,
      run: {
        ...detail.run,
        leaderTurns: detail.run.leaderTurns.map((turn: { readonly resultText: string | null }) => {
          const { resultText, ...rest } = turn;
          return resultText === null ? rest : { ...rest, resultText: 42 };
        }),
      },
    }),
    [],
  );
  assert.notDeepEqual(
    validateSquadRunRead({
      ...detail,
      run: {
        ...detail.run,
        workerAttempts: detail.run.workerAttempts.map((attempt: object) => ({ ...attempt, leaderTurnId: null })),
      },
    }),
    [],
  );
  assert.notDeepEqual(
    validateSquadRunRead({
      ...detail,
      run: {
        ...detail.run,
        leaderTurns: detail.run.leaderTurns.map((turn: { readonly trigger: { readonly kind: string } }) => ({
          ...turn,
          trigger: turn.trigger.kind === "leader_retry" ? { kind: "leader_retry", turnId: "leader-2" } : turn.trigger,
        })),
      },
    }),
    [],
  );
});

test("squad run read accepts legacy worker attempts without a worktree", () => {
  const legacy = structuredClone(detail) as Record<string, unknown>;
  const run = legacy.run as Record<string, unknown>;
  run.workerAttempts = [
    {
      attemptId: "worker-1",
      workerId: "sol",
      leaderTurnId: "leader-1",
      dispatchId: null,
      runtimeSessionId: null,
      rejection: null,
      status: null,
      startedAt: null,
      endedAt: null,
      tokenUsage: { input: 0, output: 0 },
      toolCallCount: 0,
      compacted: false,
    },
  ];
  assert.deepEqual(validateSquadRunRead(legacy), []);
});

const LEADER_RESULT_SHA = "a".repeat(64),
  LEADER_RESULT = JSON.stringify({
    schema: "runtime-batch/v1",
    dispatches: [{ to: "sol", prompt: "dig the ontology seam" }],
  });

/** 与 production writeState 同构地种一个 run:leader-1 在跑(decision 未解析),
 * 归档结算行携带 outcome/resultRef,receipt 原文落在内容包里。 */
function seedRunningSquadRun(rootDir: string, squadRunId: string): void {
  openDispatchStream(rootDir, {
    dispatchId: "dispatch_00000000000000000000a1b2",
    taskId: "task-squad",
    executionId: "execution-squad",
    runtimeSessionId: "runtime-leader",
    instanceId: "instance-squad",
    startedAt: "2026-08-27T11:00:00.000Z",
  });
  appendRuntimeWorkerRecord(rootDir, "dispatch_00000000000000000000a1b2", {
    kind: "squad_run_state",
    squadRunId,
    revision: 2,
    state: {
      schema: "squad-run/v1",
      squadRunId,
      stateDispatchId: "dispatch_00000000000000000000a1b2",
      squadId: "core-squad",
      taskId: "task-squad",
      runtimeInstanceId: "instance-squad",
      cwd: rootDir,
      mission: "fan-out witness",
      model: null,
      effort: null,
      leaderAgentId: "terra",
      roster: "terra -> sol",
      workers: ["sol"],
      leaderTurnBudget: 8,
      binding: { actor: { principal: { personId: "person-squad" }, executor: null }, source: "local" },
      leaderTurns: [
        {
          turnId: "leader-1",
          trigger: { kind: "initial" },
          dispatchId: "dispatch_00000000000000000000a1b2",
          runtimeSessionId: "runtime-leader",
          decision: null,
        },
      ],
      leaderProviderSessionId: null,
      currentLeaderRuntimeSessionId: "runtime-leader",
      workerAttempts: [],
      observedWorkerRuntimeSessionIds: [],
      workerWaits: [],
      pendingLeaderTriggers: [],
      phase: "leader_running",
      revision: 2,
      error: null,
    },
  });
  appendRuntimeWorkerRecord(rootDir, "dispatch_00000000000000000000a1b2", {
    kind: "runtime_metrics",
    inputTokens: 120,
    cacheReadTokens: 20,
    outputTokens: 30,
    totalTokens: 150,
    toolCallCount: 4,
    compacted: true,
    raw: { input_tokens: 120, output_tokens: 30 },
  });
}

/** leader 派工的归档结算行:outcome/resultRef 是 receipt 原文的既有时实来源。 */
function leaderArchive(): Record<string, unknown> {
  return {
    schema: "runtime-dispatch/v1",
    dispatchId: "dispatch_00000000000000000000a1b2",
    taskId: "task-squad",
    executionId: "execution-squad",
    runtimeSessionId: "runtime-leader",
    instanceId: "instance-squad",
    startedAt: "2026-08-27T11:00:00.000Z",
    endedAt: "2026-08-27T11:04:00.000Z",
    outcome: "succeeded",
    resultRef: `artifact:runtime-result/sha256/${LEADER_RESULT_SHA}`,
  };
}

/** 与 squad-run-list-window 同款的投影桩,外加归档后的候选来源:归档结算行会把
 * 派工从 live index 摘除,之后的台账行必须仍能从任务会话 + dispatch 事件解析——
 * 否则 observeOutcome 落盘后的 read() 会丢行(生产投影正是这个形状)。 */
function detailProjectionWith(archives: ReadonlyMap<string, Record<string, unknown>>): TaskProjection {
  const rows: { squadRunId: string; revision: number; state: unknown }[] = [];
  return {
    read: (taskId: string) => ({ watermark: 1, sourceRevision: 1, snapshot: { task: { taskId } } }),
    readTaskStatuses: () => ({ status: "ready", rows: [], watermark: 1, sourceRevision: 1 }),
    readTaskRuntimeBatch: (query: { readonly taskIds: readonly string[] }) => ({
      status: "ready" as const,
      taskIds: query.taskIds,
      rows: query.taskIds.map((taskId) => ({
        taskId,
        title: "Squad detail witness",
        packagePath: `tasks/${taskId}`,
        sessions:
          taskId === "task-squad"
            ? [
                {
                  runtimeSessionId: "runtime-leader",
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
                  lastObservedAt: "2026-08-27T11:04:00.000Z",
                },
              ]
            : [],
      })),
      watermark: 1,
      sourceRevision: 1,
    }),
    readRuntimeDispatch: (runtimeSessionId: string) =>
      runtimeSessionId === "runtime-leader"
        ? {
            type: "runtime_dispatch_requested",
            payload: { dispatchId: "dispatch_00000000000000000000a1b2", runtimeSessionId },
          }
        : null,
    readDocument: (documentPath: string) => {
      const archive = archives.get(/dispatch_[a-f0-9]{24}/u.exec(documentPath)?.[0] ?? "");
      return {
        status: "ready" as const,
        document: archive === undefined ? null : { body: JSON.stringify(archive) },
        watermark: 1,
        sourceRevision: 1,
      };
    },
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
    readRuntimeSession: () => null,
  } as unknown as TaskProjection;
}

function detailCoordinator(
  rootDir: string,
  options: { readonly receiptBlob: Uint8Array | null } = { receiptBlob: new TextEncoder().encode(LEADER_RESULT) },
) {
  // 投影必须是稳定实例:coordinator 的 upsertSquadRun memo 落在同一个 rows 上。
  const projection = detailProjectionWith(new Map([["dispatch_00000000000000000000a1b2", leaderArchive()]]));
  return makeSquadCoordinator({
    rootDir,
    projection: () => projection,
    store: () =>
      ({
        readContentBlob: (sha256: string) => (sha256 === LEADER_RESULT_SHA ? options.receiptBlob : null),
      }) as unknown as CanonicalEventStore,
    reacquireTaskLease: async () => undefined,
    publishSynthesisReport: async () => undefined,
    runtimeSpawner: () => ({
      spawn: async (): Promise<JsonObject> => ({
        ok: true,
        dispatchId: "dispatch_00000000000000000000b2c3",
        runtimeSessionId: "runtime-worker-1",
      }),
      cancel: async (): Promise<JsonObject> => ({ ok: true, outcome: "applied" }),
    }),
  });
}

const leaderOutcome = (runtimeSessionId: string) =>
  ({
    schema: "agent-runtime-event/v1",
    eventId: "event-outcome",
    workspaceRevision: 4,
    opId: "op-outcome",
    actor: { principal: { personId: "person-squad" }, executor: null },
    source: "local",
    occurredAt: new Date().toISOString(),
    type: "runtime_session_outcome_observed",
    payload: { runtimeSessionId, outcome: "succeeded", exitCode: 0, resultRef: null },
  }) as Parameters<ReturnType<typeof makeSquadCoordinator>["observeOutcome"]>[0];

test("a settled leader turn carries its receipt verbatim and its dispatches link back to the turn", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-squad-detail-"));
  try {
    seedRunningSquadRun(rootDir, "squad_0123456789abcdef01234567");
    const squad = detailCoordinator(rootDir);
    // 真实写路径:leader 结算 → 决策解析 → spawnWorker 落盘(带 leaderTurnId)。
    await squad.observeOutcome(leaderOutcome("runtime-leader"));
    const detail = squad.read("squad_0123456789abcdef01234567");
    assert.equal(detail.run.leaderTurns[0]?.decision?.kind, "plan");
    assert.equal(detail.run.leaderTurns[0]?.resultText, LEADER_RESULT);
    assert.equal(detail.run.workerAttempts[0]?.leaderTurnId, "leader-1");
    assert.equal(detail.run.workerAttempts[0]?.workerId, "sol");
    assert.equal(detail.run.workerAttempts[0]?.runtimeSessionId, "runtime-worker-1");
    assert.deepEqual(detail.run.leaderTurns[0]?.tokenUsage, { input: 120, output: 30 });
    assert.equal(detail.run.leaderTurns[0]?.toolCallCount, 4);
    assert.equal(detail.run.leaderTurns[0]?.compacted, true);
    assert.deepEqual(detail.run.workerAttempts[0]?.tokenUsage, { input: 0, output: 0 });
    assert.equal(detail.run.workerAttempts[0]?.toolCallCount, 0);
    assert.equal(detail.run.workerAttempts[0]?.compacted, false);
    const status = squad.status("squad_0123456789abcdef01234567"),
      leader = (status.leaders as Array<Record<string, unknown>>)[0],
      worker = (status.workers as Array<Record<string, unknown>>)[0];
    assert.deepEqual(leader?.tokenUsage, { input: 120, output: 30 });
    assert.equal(leader?.toolCallCount, 4);
    assert.equal(leader?.compacted, true);
    assert.deepEqual(worker?.tokenUsage, { input: 0, output: 0 });
    assert.deepEqual(validateSquadRunRead(detail), []);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a pruned or missing receipt blob reads as null instead of failing the detail read", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-squad-detail-"));
  try {
    seedRunningSquadRun(rootDir, "squad_0123456789abcdef01234567");
    const squad = detailCoordinator(rootDir, { receiptBlob: null });
    await squad.observeOutcome(leaderOutcome("runtime-leader"));
    const detail = squad.read("squad_0123456789abcdef01234567");
    assert.equal(detail.run.leaderTurns[0]?.resultText, null);
    assert.deepEqual(validateSquadRunRead(detail), []);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// 固定「现在」:窗口断言只看相对时间,不依赖真实时钟。
const NOW = "2026-08-27T12:00:00.000Z",
  DAY = 86_400_000,
  sinceAgo = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();

/** 一条已落盘的派工事实:流头部 startedAt 恒有;归档结算行的 endedAt 按需补。 */
type DispatchFact = {
  readonly dispatchId: string;
  readonly runtimeSessionId: string;
  readonly startedAt: string;
  readonly endedAt?: string;
};

type SeedOptions = {
  readonly squadRunId: string;
  readonly phase: "planning" | "leader_running" | "workers_running" | "converged" | "failed";
  readonly leader: DispatchFact;
  readonly worker?: DispatchFact;
  readonly taskId?: string;
};

/** 与 production writeState 同构地种一个 run:squad_run_state 记录落在 leader 初始派工
 * 流里(状态流 = 首个 leader 派工流),leader/worker 派工流按各自 startedAt 落盘。 */
function seedSquadRun(rootDir: string, options: SeedOptions): void {
  const taskId = options.taskId ?? "task-squad";
  for (const fact of [options.leader, options.worker])
    if (fact)
      openDispatchStream(rootDir, {
        dispatchId: fact.dispatchId,
        taskId,
        executionId: "execution-squad",
        runtimeSessionId: fact.runtimeSessionId,
        instanceId: "instance-squad",
        startedAt: fact.startedAt,
      });
  appendRuntimeWorkerRecord(rootDir, options.leader.dispatchId, {
    kind: "squad_run_state",
    squadRunId: options.squadRunId,
    revision: 3,
    state: {
      schema: "squad-run/v1",
      squadRunId: options.squadRunId,
      stateDispatchId: options.leader.dispatchId,
      squadId: "core-squad",
      taskId,
      runtimeInstanceId: "instance-squad",
      cwd: rootDir,
      mission: "window filter witness",
      model: null,
      effort: null,
      leaderAgentId: "terra",
      roster: "terra -> sol",
      workers: ["sol"],
      leaderTurnBudget: 8,
      binding: { actor: { principal: { personId: "person-squad" }, executor: null }, source: "local" },
      leaderTurns: [
        {
          turnId: "leader-1",
          trigger: { kind: "initial" },
          dispatchId: options.leader.dispatchId,
          runtimeSessionId: options.leader.runtimeSessionId,
          decision: { kind: "converged" },
        },
      ],
      leaderProviderSessionId: null,
      currentLeaderRuntimeSessionId: null,
      workerAttempts: options.worker
        ? [
            {
              attemptId: "worker-1",
              workerId: "sol",
              dispatchId: options.worker.dispatchId,
              runtimeSessionId: options.worker.runtimeSessionId,
              rejection: null,
            },
          ]
        : [],
      observedWorkerRuntimeSessionIds: [],
      workerWaits: [],
      pendingLeaderTriggers: [],
      phase: options.phase,
      revision: 3,
      error: null,
    },
  });
}

/** 归档结算文档(dispatch-read archiveRow 的来源):endedAt 事实只从这条来。 */
function archiveDoc(
  fact: DispatchFact & { readonly endedAt: string },
  taskId: string = "task-squad",
): Record<string, unknown> {
  return {
    schema: "runtime-dispatch/v1",
    dispatchId: fact.dispatchId,
    taskId,
    executionId: "execution-squad",
    runtimeSessionId: fact.runtimeSessionId,
    instanceId: "instance-squad",
    startedAt: fact.startedAt,
    endedAt: fact.endedAt,
  };
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

/** 只给 list/readStates 走到的读面装桩:成员会话按需可解析或恒缺失;派工台账行来自
 * 真实派工流 + live index(startedAt),归档结算行(endedAt)按 dispatchId 呈现。
 * packagePathFor 允许把个别 task 的包路径投成 null(readTaskDispatches 对单 task 查询
 * 缺包路径即抛,生产投影里 task 无包路径的形态);batchCalls 记录台账读的批量批读。 */
function windowProjectionWith(
  sessions: readonly RuntimeSession[],
  archives: ReadonlyMap<string, Record<string, unknown>> = new Map(),
  packagePathFor: (taskId: string) => string | null = (taskId) => `tasks/${taskId}`,
): TaskProjection & { readonly batchCalls: readonly (readonly string[])[] } {
  const rows: { squadRunId: string; revision: number; state: unknown }[] = [],
    batchCalls: (readonly string[])[] = [];
  return {
    read: () => ({ watermark: 1, sourceRevision: 1, snapshot: { task: { taskId: "squad-window-witness" } } }),
    readTaskStatuses: () => ({ status: "ready", rows: [], watermark: 1, sourceRevision: 1 }),
    readTaskRuntimeBatch: (query: { readonly taskIds: readonly string[] }) => {
      batchCalls.push(query.taskIds);
      return {
        status: "ready" as const,
        taskIds: query.taskIds,
        rows: query.taskIds.map((taskId) => ({
          taskId,
          title: "Squad window witness",
          packagePath: packagePathFor(taskId),
          sessions: [],
        })),
        watermark: 1,
        sourceRevision: 1,
      };
    },
    readDocument: (documentPath: string) => {
      const archive = archives.get(/dispatch_[a-f0-9]{24}/u.exec(documentPath)?.[0] ?? "");
      return {
        status: "ready" as const,
        document: archive === undefined ? null : { body: JSON.stringify(archive) },
        watermark: 1,
        sourceRevision: 1,
      };
    },
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
    batchCalls,
  } as unknown as TaskProjection & { readonly batchCalls: readonly (readonly string[])[] };
}

function coordinator(
  rootDir: string,
  sessions: readonly RuntimeSession[],
  archives: ReadonlyMap<string, Record<string, unknown>> = new Map(),
  packagePathFor?: (taskId: string) => string | null,
) {
  const projection = windowProjectionWith(sessions, archives, packagePathFor ?? ((taskId) => `tasks/${taskId}`));
  return {
    coordinator: makeSquadCoordinator({
      rootDir,
      projection: () => projection,
      store: () => {
        throw new Error("store is not exercised by the list window");
      },
      reacquireTaskLease: async () => undefined,
      publishSynthesisReport: async () => undefined,
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

test("a terminal run whose member sessions are missing still passes a window covering its last settled dispatch", () => {
  withRootDir((rootDir) => {
    const worker = {
      dispatchId: "dispatch_00000000000000000000b2c3",
      runtimeSessionId: "runtime-worker",
      startedAt: "2026-08-27T11:30:00.000Z",
      endedAt: "2026-08-27T11:55:00.000Z",
    };
    seedSquadRun(rootDir, {
      squadRunId: "squad_0123456789abcdef01234567",
      phase: "converged",
      leader: {
        dispatchId: "dispatch_00000000000000000000a1b2",
        runtimeSessionId: "runtime-leader",
        startedAt: "2026-08-27T11:00:00.000Z",
      },
      worker,
    });
    // 投影里没有任何成员会话行(未孵化/已被裁剪):唯一活动证据是 run 自有的派工事实。
    const { coordinator: squad } = coordinator(rootDir, [], new Map([[worker.dispatchId, archiveDoc(worker)]]));
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
      leader: {
        dispatchId: "dispatch_00000000000000000000a1b2",
        runtimeSessionId: "runtime-leader",
        startedAt: "2026-08-19T10:00:00.000Z",
      },
      worker: {
        dispatchId: "dispatch_00000000000000000000b2c3",
        runtimeSessionId: "runtime-worker",
        startedAt: "2026-08-20T11:55:00.000Z",
      },
    });
    const { coordinator: squad } = coordinator(rootDir, []);
    assert.deepEqual(squad.list({ since: sinceAgo(DAY) }).totals, { runs: 0 });
    assert.deepEqual(squad.list({ since: sinceAgo(30 * DAY) }).totals, { runs: 1 });
  });
});

test("member session activity later than every dispatch fact wins as latestActivityAt", () => {
  withRootDir((rootDir) => {
    seedSquadRun(rootDir, {
      squadRunId: "squad_0123456789abcdef01234567",
      phase: "converged",
      leader: {
        dispatchId: "dispatch_00000000000000000000a1b2",
        runtimeSessionId: "runtime-leader",
        startedAt: "2026-08-27T11:00:00.000Z",
      },
      worker: {
        dispatchId: "dispatch_00000000000000000000b2c3",
        runtimeSessionId: "runtime-worker",
        startedAt: "2026-08-27T11:30:00.000Z",
      },
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
      leader: {
        dispatchId: "dispatch_00000000000000000000a1b2",
        runtimeSessionId: "runtime-leader",
        startedAt: "2026-08-01T00:00:00.000Z",
      },
      worker: {
        dispatchId: "dispatch_00000000000000000000b2c3",
        runtimeSessionId: "runtime-worker",
        startedAt: "2026-08-01T01:00:00.000Z",
      },
    });
    seedSquadRun(rootDir, {
      squadRunId: "squad_0123456789abcdef99887766",
      phase: "failed",
      leader: {
        dispatchId: "dispatch_00000000000000000000c3d4",
        runtimeSessionId: "runtime-leader-2",
        startedAt: "2026-08-01T00:00:00.000Z",
      },
    });
    const { coordinator: squad } = coordinator(rootDir, []);
    assert.deepEqual(squad.list({ since: sinceAgo(DAY) }).totals, { runs: 1 });
    assert.deepEqual(squad.list({}).totals, { runs: 2 });
  });
});

test("one invalid Squad run projection degrades without hiding valid runs", () => {
  withRootDir((rootDir) => {
    seedSquadRun(rootDir, {
      squadRunId: "squad_0123456789abcdef01234567",
      phase: "converged",
      leader: {
        dispatchId: "dispatch_00000000000000000000a1b2",
        runtimeSessionId: "runtime-leader",
        startedAt: "2026-08-27T11:00:00.000Z",
      },
    });
    const { coordinator: squad, projection } = coordinator(rootDir, []);
    assert.equal(squad.list({}).runs.length, 1, "materialize the healthy run projection first");
    projection.upsertSquadRun({
      squadRunId: "squad_0123456789abcdef99887766",
      revision: 4,
      state: { schema: "squad-run/v1", squadRunId: "squad_0123456789abcdef99887766" },
    });

    const listed = squad.list({});
    assert.equal(listed.runs.length, 2);
    assert.deepEqual(
      listed.runs.find((run) => run.squadRunId === "squad_0123456789abcdef99887766"),
      {
        squadRunId: "squad_0123456789abcdef99887766",
        projectionState: "invalid",
        projectionError: {
          code: "squad_run_projection_invalid",
          hint: "Squad run projection squad_0123456789abcdef99887766 is invalid.",
        },
      },
    );
    assert.deepEqual(validateSquadRunsList(listed), []);
    const detail = squad.read("squad_0123456789abcdef99887766");
    assert.deepEqual(detail.run, listed.runs[1]);
    assert.deepEqual(validateSquadRunRead(detail), []);
    const status = squad.status("squad_0123456789abcdef99887766");
    assert.equal(status.projectionState, "invalid");
    assert.equal((status.projectionError as { readonly code: string }).code, "squad_run_projection_invalid");
  });
});

test("the window and the ordering compare instants, so a second-precision stamp does not sneak past a millisecond cutoff", () => {
  withRootDir((rootDir) => {
    seedSquadRun(rootDir, {
      squadRunId: "squad_0123456789abcdef01234567",
      phase: "converged",
      leader: {
        dispatchId: "dispatch_00000000000000000000a1b2",
        runtimeSessionId: "runtime-leader",
        startedAt: "2026-08-26T23:00:00.000Z",
      },
      worker: {
        dispatchId: "dispatch_00000000000000000000b2c3",
        runtimeSessionId: "runtime-worker",
        startedAt: "2026-08-27T00:00:00.500Z",
      },
    });
    seedSquadRun(rootDir, {
      squadRunId: "squad_0123456789abcdef99887766",
      phase: "converged",
      leader: {
        dispatchId: "dispatch_00000000000000000000c3d4",
        runtimeSessionId: "runtime-leader-2",
        startedAt: "2026-08-26T23:00:00.000Z",
      },
      worker: {
        dispatchId: "dispatch_00000000000000000000d4e5",
        runtimeSessionId: "runtime-worker-2",
        startedAt: "2026-08-27T00:00:00Z",
      },
    });
    const { coordinator: squad } = coordinator(rootDir, []);
    // 字典序里 "…00Z" > "…00.500Z"('Z' > '.'):进出窗与先后排序都必须按瞬值判。
    assert.deepEqual(squad.list({ since: "2026-08-27T00:00:00.500Z" }).totals, { runs: 1 });
    assert.deepEqual(squad.list({ since: "2026-08-27T00:00:00.000Z" }).totals, { runs: 2 });
    assert.deepEqual(
      squad.list({}).runs.map(({ squadRunId }) => squadRunId),
      ["squad_0123456789abcdef01234567", "squad_0123456789abcdef99887766"],
    );
  });
});

test("the real write path keeps deriving activity from dispatch facts, not a persisted clock", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-squad-window-"));
  try {
    seedSquadRun(rootDir, {
      squadRunId: "squad_0123456789abcdef01234567",
      phase: "workers_running",
      leader: {
        dispatchId: "dispatch_00000000000000000000a1b2",
        runtimeSessionId: "runtime-leader",
        startedAt: "2026-01-15T07:00:00.000Z",
      },
      worker: {
        dispatchId: "dispatch_00000000000000000000b2c3",
        runtimeSessionId: "runtime-worker",
        startedAt: "2026-01-15T08:00:00.000Z",
      },
    });
    const { coordinator: squad } = coordinator(rootDir, []);
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
    // 落盘不再自带时钟:活动时间仍是 worker 派工的已落盘事实,不是 wall-clock,更不是 epoch。
    assert.equal(squad.list({}).runs[0]?.latestActivityAt, "2026-01-15T08:00:00.000Z");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a run whose task has no projected package path fails the list", () => {
  withRootDir((rootDir) => {
    const worker = {
      dispatchId: "dispatch_00000000000000000000b2c3",
      runtimeSessionId: "runtime-worker",
      startedAt: "2026-08-27T11:30:00.000Z",
      endedAt: "2026-08-27T11:55:00.000Z",
    };
    seedSquadRun(rootDir, {
      squadRunId: "squad_0123456789abcdef01234567",
      phase: "converged",
      leader: {
        dispatchId: "dispatch_00000000000000000000a1b2",
        runtimeSessionId: "runtime-leader",
        startedAt: "2026-08-27T11:00:00.000Z",
      },
      worker,
    });
    seedSquadRun(rootDir, {
      squadRunId: "squad_0123456789abcdef99887766",
      phase: "converged",
      taskId: "task-no-package",
      leader: {
        dispatchId: "dispatch_00000000000000000000e5f6",
        runtimeSessionId: "runtime-leader-broken",
        startedAt: "2026-08-27T11:40:00.000Z",
      },
    });
    const { coordinator: squad } = coordinator(
      rootDir,
      [],
      new Map([[worker.dispatchId, archiveDoc(worker)]]),
      (taskId) => (taskId === "task-no-package" ? null : `tasks/${taskId}`),
    );
    assert.throws(() => squad.list({}), /Task task-no-package has no projected package path/u);
  });
});

test("one list reads the dispatch ledger once per task, not once per run", () => {
  withRootDir((rootDir) => {
    for (const [squadRunId, suffix] of [
      ["squad_0123456789abcdef01234567", "a1b2"],
      ["squad_0123456789abcdef99887766", "c3d4"],
      ["squad_0123456789abcdef55554444", "e5f6"],
    ] as const) {
      seedSquadRun(rootDir, {
        squadRunId,
        phase: "converged",
        leader: {
          dispatchId: `dispatch_00000000000000000000${suffix}`,
          runtimeSessionId: `runtime-leader-${suffix}`,
          startedAt: "2026-08-27T11:00:00.000Z",
        },
      });
    }
    const { coordinator: squad, projection } = coordinator(rootDir, []);
    squad.list({});
    // 同一 task 的多个 run 共享一次台账读:批量批读按 task 数结算,不随 run 数放大。
    assert.deepEqual(projection.batchCalls, [["task-squad"]]);
    // memo 只在单次 list 内生效:下一次 list 重新读,不吞掉两次 list 之间新落盘的事实。
    squad.list({});
    assert.deepEqual(projection.batchCalls, [["task-squad"], ["task-squad"]]);
  });
});

test("a terminal run whose only activity fact is the leader dispatch passes the window", () => {
  withRootDir((rootDir) => {
    seedSquadRun(rootDir, {
      squadRunId: "squad_0123456789abcdef01234567",
      phase: "converged",
      leader: {
        dispatchId: "dispatch_00000000000000000000a1b2",
        runtimeSessionId: "runtime-leader",
        startedAt: "2026-08-27T10:00:00.000Z",
      },
    });
    const { coordinator: squad } = coordinator(rootDir, []);
    // 定点对照(派生去掉派工事实 → 红):无会话、无归档,窗口内可见的唯一证据是台账行
    // 的 startedAt;派生若只剩会话,该 run 退化为 epoch 并在窗口内消失。
    const listed = squad.list({ since: sinceAgo(DAY) });
    assert.deepEqual(listed.totals, { runs: 1 });
    assert.equal(listed.runs[0]?.latestActivityAt, "2026-08-27T10:00:00.000Z");
  });
});

test("the summary ordering compares instants; a lexicographic stamp comparison would flip it", () => {
  withRootDir((rootDir) => {
    seedSquadRun(rootDir, {
      squadRunId: "squad_0123456789abcdef01234fff",
      phase: "converged",
      leader: {
        dispatchId: "dispatch_00000000000000000000a1b2",
        runtimeSessionId: "runtime-leader-a",
        startedAt: "2026-08-27T11:00:00.500Z",
      },
    });
    seedSquadRun(rootDir, {
      squadRunId: "squad_0123456789abcdef01234000",
      phase: "converged",
      leader: {
        dispatchId: "dispatch_00000000000000000000c3d4",
        runtimeSessionId: "runtime-leader-b",
        startedAt: "2026-08-27T11:00:00Z",
      },
    });
    const { coordinator: squad } = coordinator(rootDir, []);
    // 定点对照(排序回退字典序 → 红):唯一活动事实分别是裸秒戳 "…00Z" 与 "…00.500Z",
    // 字典序里 "…00Z" 更大('Z' > '.'),降序会先列秒精度 run;排序若把两者判等,
    // squadRunId 兜底(升序)同样先列它(.500 run 的 id 故意取大,排除兜底碰对)。
    assert.deepEqual(
      squad.list({}).runs.map(({ squadRunId }) => squadRunId),
      ["squad_0123456789abcdef01234fff", "squad_0123456789abcdef01234000"],
    );
  });
});
