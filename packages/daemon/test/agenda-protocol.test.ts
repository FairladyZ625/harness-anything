// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseDaemonRpcParams, validateDaemonAgenda } from "../src/protocol/daemon-protocol.contract.ts";

test("agenda RPC accepts only its bounded page payload", () => {
  const parse = (payload: Record<string, unknown>) => parseDaemonRpcParams("repo.agenda.read", { repo: { repoId: "alpha" }, payload });
  assert.equal(parse({ limit: 25, cursor: "agenda-cursor" }).ok, true);
  assert.equal(parse({ limit: 0 }).ok, false);
  assert.equal(parse({ status: "active" }).ok, false);
});

test("agenda result schema rejects mistyped pin state", () => {
  const task = { taskId: "task-current", title: "Current task", status: "blocked", pinned: true, updatedAt: "2026-08-21T00:00:00.000Z", leaseExecutionId: null, activeExecutionIds: [], blockingAssessment: { taskId: "task-current", state: "clear", blockers: [], warnings: [] } };
  const agenda = { schema: "daemon.agenda/v1", ok: true, command: "agenda", status: "ready", inFlight: [], awaitingDecision: [], waitingOnOthers: [task], dispatchable: [], page: { sourceLimit: 100, cursor: null, nextCursor: null }, watermark: 1, sourceRevision: 1, warnings: [{ code: "projection_missing", source: "generated-cache", severity: "warning", message: "Projection was rebuilt." }], summary: "球在别人手里 (1)" };
  assert.deepEqual(validateDaemonAgenda(agenda), []);
  assert.notDeepEqual(validateDaemonAgenda({ ...agenda, waitingOnOthers: [{ ...task, pinned: "true" }] }), []);
});
