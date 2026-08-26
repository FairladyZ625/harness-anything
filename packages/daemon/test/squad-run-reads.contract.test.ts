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
const read = {
  ok: true as const,
  status: "ready" as const,
  run: {
    leaders: [
      {
        turnId: "leader-2",
        dispatchId: "dispatch_111111111111111111111111",
        runtimeSessionId: "runtime-leader-2",
        agentName: "commander",
        instanceId: "runtime-instance",
        status: "running" as const,
        startedAt: "2026-08-26T00:00:00.000Z",
      },
    ],
    workers: [
      {
        attemptId: "worker-1",
        dispatchId: "dispatch_222222222222222222222222",
        runtimeSessionId: "runtime-worker-1",
        agentName: "terra",
        instanceId: "runtime-instance",
        status: "succeeded" as const,
        startedAt: "2026-08-25T23:00:00.000Z",
        rejection: null,
      },
    ],
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
  assert.notDeepEqual(validate("repo.squad.runs.list", { cursor: "retired" }), []);
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
