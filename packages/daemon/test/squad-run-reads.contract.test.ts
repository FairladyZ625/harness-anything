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

const squadRunId = "squad_0123456789abcdef01234567";
const summary = {
  squadRunId,
  squadId: "core-squad",
  taskId: "task-runtime",
  mission: "Review the runtime read model",
  phase: "leader_running" as const,
  revision: 4,
  leaderTurnCount: 2,
  workerAttemptCount: 1,
  runningCount: 1,
  latestActivityAt: "2026-08-26T00:00:00.000Z",
  currentLeaderRuntimeSessionId: "runtime-leader-2",
};
const page = { limit: 200, cursor: null, nextCursor: null, remainingCount: 0 };
const list = {
  ok: true as const,
  status: "ready" as const,
  runs: [summary],
  totals: { runs: 1 },
  truncated: false,
  page,
  watermark: 42,
  sourceRevision: 42,
};
const read = {
  ok: true as const,
  status: "ready" as const,
  run: {
    squadRunId,
    squadId: "core-squad",
    taskId: "task-runtime",
    mission: "Review the runtime read model",
    phase: "leader_running" as const,
    revision: 4,
    currentLeaderRuntimeSessionId: "runtime-leader-2",
    leaderRuntimeSessionIds: ["runtime-leader-1", "runtime-leader-2"],
    leaders: [
      {
        turnId: "leader-2",
        trigger: { kind: "worker_outcome", runtimeSessionId: "runtime-worker-1" },
        dispatchId: "dispatch_111111111111111111111111",
        runtimeSessionId: "runtime-leader-2",
        decision: null,
      },
    ],
    workers: [
      {
        attemptId: "worker-1",
        workerId: "terra",
        dispatchId: "dispatch_222222222222222222222222",
        runtimeSessionId: "runtime-worker-1",
        status: "succeeded",
      },
    ],
    workerCallbackCount: 1,
    pendingLeaderCallbackCount: 0,
    error: null,
  },
  watermark: 42,
  sourceRevision: 42,
};

test("squad run read facets are registered and reject malformed bounds", () => {
  assert.deepEqual(
    daemonGuiReadMethods.filter(({ method }) => method.startsWith("repo.squad.runs.")).map(({ method }) => method),
    ["repo.squad.runs.list", "repo.squad.runs.read"],
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
  assert.deepEqual(validate("repo.squad.runs.read", { squadRunId }), []);
  assert.notDeepEqual(validate("repo.squad.runs.read", { squadRunId: "core-squad" }), []);
});

test("squad run list and detail validators lock the redacted wire shape", () => {
  assert.deepEqual(validateSquadRunsList(list), []);
  assert.deepEqual(validateSquadRunRead(read), []);
  assert.equal(parseDaemonGuiReadResult("repo.squad.runs.list", list), list);
  assert.equal(parseDaemonGuiReadResult("repo.squad.runs.read", read), read);
  assert.equal(serializeSquadRunsList(list), `${JSON.stringify(list)}\n`);
  assert.equal(serializeSquadRunRead(read), `${JSON.stringify(read)}\n`);
  assert.notDeepEqual(validateSquadRunsList({ ...list, token: "secret" }), []);
  assert.notDeepEqual(validateSquadRunRead({ ...read, run: { ...read.run, phase: "done" } }), []);
});
