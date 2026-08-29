// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { daemonGuiReadMethods, validateDaemonRpcCall } from "../src/protocol/daemon-protocol.contract.ts";
import { parseDaemonGuiReadResult } from "../src/protocol/gui-result-validation.ts";
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
        resultText: '{"schema":"runtime-batch/v1","dispatches":[{"instance":"i","to":"terra","prompt":"go"}]}',
        status: "succeeded" as const,
        startedAt: "2026-08-26T00:00:00.000Z",
        endedAt: "2026-08-26T00:05:00.000Z",
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
