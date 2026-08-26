// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { daemonGuiReadMethods, validateDaemonRpcCall } from "../src/protocol/daemon-protocol.contract.ts";
import { parseDaemonGuiReadResult } from "../src/protocol/gui-result-validation.ts";
import { serializeSquadRunsList, validateSquadRunsList } from "../src/squad-run-contract.ts";

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
test("squad run list facet is registered and rejects malformed bounds", () => {
  assert.deepEqual(
    daemonGuiReadMethods.filter(({ method }) => method.startsWith("repo.squad.runs.")).map(({ method }) => method),
    ["repo.squad.runs.list"],
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

test("squad run list validator locks the redacted wire shape", () => {
  assert.deepEqual(validateSquadRunsList(list), []);
  assert.equal(parseDaemonGuiReadResult("repo.squad.runs.list", list), list);
  assert.equal(serializeSquadRunsList(list), `${JSON.stringify(list)}\n`);
  assert.notDeepEqual(validateSquadRunsList({ ...list, token: "secret" }), []);
});
