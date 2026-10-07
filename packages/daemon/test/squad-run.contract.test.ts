// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { type CanonicalSquadRun, type RuntimeSession, type TaskProjection } from "@harness-anything/kernel";
import { appendRuntimeWorkerRecord, archiveDispatchStream, openDispatchStream } from "../src/dispatch-stream.ts";
import { daemonGuiReadMethods, validateDaemonRpcCall } from "../src/protocol/daemon-protocol.contract.ts";
import { parseDaemonGuiReadResult } from "../src/protocol/gui-result-validation.ts";
import { makeSquadCanonicalReader } from "../src/squad-canonical-read.ts";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { latestSquadStates } from "../src/squad-run-state.ts";
import {
  serializeSquadRunRead,
  serializeSquadRunsList,
  validateSquadRunRead,
  validateSquadRunsList,
} from "../src/squad-run-contract.ts";

const identity = {
  executionId: "execution-squad",
  iteration: 1,
  currentIteration: 2,
  runRevision: 2,
  acceptedRevision: 42,
  acceptedAt: "2026-08-26T00:00:00.000Z",
  owner: { source: "local", personId: "person-squad" },
};
const summary = {
  ...identity,
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
    ...identity,
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
        taskId: null,
        executionId: null,
        worktree: null,
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
        taskId: null,
        executionId: null,
        worktree: null,
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
  for (const key of ["token", "access_token", "id_token"])
    assert.notDeepEqual(validateSquadRunsList({ ...list, [key]: "secret" }), [], `${key} must stay rejected`);
});

test("squad run read validator locks the orchestration-flow wire shape", () => {
  assert.deepEqual(validateSquadRunRead(detail), []);
  assert.equal(parseDaemonGuiReadResult("repo.squad.run.read", detail), detail);
  assert.equal(serializeSquadRunRead(detail), `${JSON.stringify(detail)}\n`);
  for (const key of ["token", "access_token", "id_token"])
    assert.notDeepEqual(validateSquadRunRead({ ...detail, [key]: "secret" }), [], `${key} must stay rejected`);
  // tokenUsage counts pass on their value type (numbers), never on the key name: a string under
  // that name is a credential and must be rejected, exemption-free.
  const stringTokenUsage = {
    ...detail,
    run: {
      ...detail.run,
      leaderTurns: detail.run.leaderTurns.map((turn: { readonly tokenUsage: unknown }) => ({
        ...turn,
        tokenUsage: "ghp_secret",
      })),
    },
  };
  assert.notDeepEqual(validateSquadRunRead(stringTokenUsage), []);
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

test("squad run read requires explicit public worker identity and rejects machine paths", () => {
  const value = structuredClone(detail) as Record<string, unknown>;
  const run = value.run as Record<string, unknown>;
  run.workerAttempts = [
    {
      attemptId: "worker-1",
      taskId: null,
      executionId: null,
      worktree: null,
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
  assert.deepEqual(validateSquadRunRead(value), []);
  const workers = run.workerAttempts as Record<string, unknown>[];
  delete workers[0]!.worktree;
  assert.notDeepEqual(validateSquadRunRead(value), []);
  workers[0]!.worktree = { cwd: "/private/owner", branch: "worker", baseSha: "a".repeat(40) };
  assert.notDeepEqual(validateSquadRunRead(value), []);
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
      executionId: "execution-squad",
      publicMission: "fan-out witness",
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

test("squad state rebuild replays an archived leader stream", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-squad-archive-rebuild-"));
  try {
    const squadRunId = "squad_0123456789abcdef01234567";
    seedRunningSquadRun(rootDir, squadRunId);
    archiveDispatchStream(rootDir, "dispatch_00000000000000000000a1b2");
    assert.equal(latestSquadStates(rootDir).get(squadRunId)?.revision, 2);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function canonicalFixture() {
  const run: CanonicalSquadRun = {
    squadRunId: summary.squadRunId,
    squadId: summary.squadId,
    taskId: summary.taskId,
    executionId: identity.executionId,
    mission: summary.mission,
    leaderAgentId: "terra",
    ownerDispatchId: "dispatch_000000000000000000000001",
    runRevision: 2,
    phase: "leader_running",
    error: null,
    currentLeaderRuntimeSessionId: "runtime-leader",
    leaderTurns: [
      {
        turnId: "leader-1",
        trigger: { kind: "initial" },
        dispatchId: "dispatch_000000000000000000000001",
        runtimeSessionId: "runtime-leader",
        decision: null,
      },
    ],
    workerAttempts: [],
    workerCallbackCount: 0,
    pendingLeaderCallbackCount: 0,
    synthesisReportPath: null,
    owner: { source: "local", personId: "person-squad" },
    acceptedAt: identity.acceptedAt,
    acceptedRevision: 42,
  };
  const rows = [run];
  let resultRef: string | null = null,
    result = "Complete immutable result\n";
  const projection = {
    readCut: () => ({ status: "ready", watermark: 42, sourceRevision: 42 }),
    read: () => ({
      snapshot: { task: { iteration: 2 }, executions: [{ executionId: identity.executionId, iteration: 1 }] },
    }),
    readSquadRun: (id: string) => {
      const state = rows.find((r) => r.squadRunId === id);
      return state ? { state, revision: state.acceptedRevision } : null;
    },
    readSquadRuns: () => rows.map((state) => ({ state, revision: state.acceptedRevision })),
    readRuntimeSession: () =>
      ({
        runtimeSessionId: "runtime-leader",
        liveness: "live",
        outcome: null,
        resultRef,
        lastObservedAt: identity.acceptedAt,
      }) as RuntimeSession,
    readRuntimeDispatch: () => ({ payload: {}, occurredAt: identity.acceptedAt }),
    readRuntimeSessionEvents: () => [],
  } as unknown as TaskProjection;
  return {
    rows,
    reader: makeSquadCanonicalReader({
      projection,
      readResult: () => {
        if (!result) throw new Error("replica_unavailable");
        return result;
      },
    }),
    setResult: (value: string) => {
      result = value;
      resultRef = `artifact:runtime-result/sha256/${"a".repeat(64)}`;
    },
  };
}

test("canonical Squad read survives a filesystem trap and exposes frozen execution and accepted revisions", (t) => {
  const f = canonicalFixture();
  f.rows[0] = {
    ...f.rows[0]!,
    workerAttempts: [
      {
        attemptId: "worker-observed",
        workerId: "worker",
        leaderTurnId: "leader-1",
        taskId: "task-child",
        executionId: "execution-child",
        dispatchId: null,
        runtimeSessionId: null,
        rejection: "not started",
        branch: "squad/worker",
        baseSha: "a".repeat(40),
      },
    ],
  };
  for (const method of ["readFileSync", "openSync", "readdirSync", "statSync", "existsSync"] as const)
    t.mock.method(fs, method, () => {
      throw new Error(`public Squad read touched ${method}`);
    });
  syncBuiltinESMExports();
  try {
    const detail = f.reader.read(summary.squadRunId);
    assert.deepEqual(validateSquadRunRead(detail), []);
    assert.deepEqual(validateSquadRunsList(f.reader.list({})), []);
    assert.equal(detail.run.executionId, identity.executionId);
    assert.deepEqual(detail.run.workerAttempts[0]?.worktree, { branch: "squad/worker", baseSha: "a".repeat(40) });
    assert.equal(detail.run.workerAttempts[0]?.taskId, "task-child");
    assert.equal(detail.run.workerAttempts[0]?.executionId, "execution-child");
    assert.equal(detail.run.iteration, 1);
    assert.equal(detail.run.currentIteration, 2);
    assert.equal(detail.run.runRevision, 2);
    assert.equal(f.reader.status(summary.squadRunId).runRevision, 2);
    assert.deepEqual(detail.run.leaderTurns[0]?.tokenUsage, { input: null, output: null });
    assert.equal(detail.run.leaderTurns[0]?.compacted, null);
    assert.equal(detail.run.leaderTurns[0]?.toolCallCount, null);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("Squad result absence is null, a complete result is verbatim and a missing referenced blob fails", () => {
  const f = canonicalFixture();
  assert.equal(f.reader.read(summary.squadRunId).run.leaderTurns[0]?.resultText, null);
  const complete = "完整结果\n".repeat(10_000);
  f.setResult(complete);
  assert.equal(f.reader.read(summary.squadRunId).run.leaderTurns[0]?.resultText, complete);
  f.setResult("");
  assert.throws(() => f.reader.read(summary.squadRunId), /replica_unavailable/u);
});

test("canonical list filters terminal observations by accepted instants, keeps active history and bounds results", () => {
  const f = canonicalFixture(),
    initial = f.rows[0]!;
  f.rows.push(
    {
      ...initial,
      squadRunId: "squad_111111111111111111111111",
      phase: "converged",
      acceptedAt: "2026-08-26T00:00:00Z",
    },
    {
      ...initial,
      squadRunId: "squad_222222222222222222222222",
      phase: "failed",
      acceptedAt: "2026-08-26T00:00:00.002Z",
    },
  );
  const selected = f.reader.list({ since: "2026-08-26T00:00:00.001Z" });
  assert.deepEqual(
    selected.runs.map((r) => r.squadRunId),
    [initial.squadRunId, "squad_222222222222222222222222"],
  );
  assert.equal(f.reader.list({ limit: 1 }).truncated, true);
  assert.equal(f.reader.list({ query: "failed runtime" }).runs.length, 1);
  assert.equal(f.reader.list({ query: "missing" }).runs.length, 0);
  assert.equal(f.reader.list({}).totals.runs, 3);
});

test("unknown run is explicit and public reads cannot reveal local control state", () => {
  const f = canonicalFixture();
  assert.throws(() => f.reader.read("squad_333333333333333333333333"), /does not exist/u);
  assert.throws(() => f.reader.read("../local"), /canonical/u);
  const wire = serializeSquadRunRead(f.reader.read(summary.squadRunId));
  assert.doesNotMatch(wire, /cwd|providerHome|binding|roster|pendingLeaderTriggers/u);
});
