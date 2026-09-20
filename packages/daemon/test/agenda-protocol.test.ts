// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseDaemonRpcParams, validateDaemonAgenda } from "../src/protocol/daemon-protocol.contract.ts";

test("agenda RPC accepts only its bounded page payload", () => {
  const parse = (payload: Record<string, unknown>) =>
    parseDaemonRpcParams("repo.agenda.read", { repo: { repoId: "alpha" }, payload });
  assert.equal(parse({ limit: 25, cursor: "agenda-cursor" }).ok, true);
  assert.equal(parse({ limit: 0 }).ok, false);
  assert.equal(parse({ status: "active" }).ok, false);
});

test("agenda result schema rejects mistyped pin state and misgrouped awaiting rows", () => {
  const task = {
      taskId: "task-current",
      title: "Current task",
      status: "blocked",
      pinned: true,
      updatedAt: "2026-08-21T00:00:00.000Z",
      leaseExecutionId: null,
      activeExecutionIds: [],
      blockingAssessment: { taskId: "task-current", state: "clear", label: "none", blockers: [], warnings: [] },
    },
    execution = {
      taskId: "task-awaiting",
      title: "Awaiting execution",
      pinned: false,
      executionId: "exe-awaiting",
      submittedAt: "2026-08-21T00:00:00.000Z",
      blockingAssessment: { taskId: "task-awaiting", state: "clear", label: "none", blockers: [], warnings: [] },
    },
    decision = {
      decisionId: "dec-awaiting",
      title: "Awaiting decision",
      riskTier: "medium",
      urgency: "high",
      proposedAt: "2026-08-21T00:00:00.000Z",
    },
    agenda = {
      schema: "daemon.agenda/v1",
      ok: true,
      command: "agenda",
      status: "ready",
      pinnedEntities: [],
      pinnedEntityOverflow: 0,
      inFlight: [],
      awaitingRework: [],
      awaitingAdjudication: [execution],
      underReview: [],
      awaitingDecision: [decision],
      waitingOnOthers: [task],
      dispatchable: [],
      page: { sourceLimit: 100, cursor: null, nextCursor: null },
      watermark: 1,
      sourceRevision: 1,
      warnings: [
        {
          code: "projection_missing",
          source: "generated-cache",
          severity: "warning",
          message: "Projection was rebuilt.",
        },
      ],
      summary: "球在别人手里 (1)",
    };
  assert.deepEqual(validateDaemonAgenda(agenda), []);
  assert.notDeepEqual(validateDaemonAgenda({ ...agenda, waitingOnOthers: [{ ...task, pinned: "true" }] }), []);
  // Each awaiting group admits only its own row shape: an execution row in the decision
  // group (the old mixed shape) and vice versa are both refused.
  assert.notDeepEqual(validateDaemonAgenda({ ...agenda, awaitingDecision: [execution] }), []);
  assert.notDeepEqual(validateDaemonAgenda({ ...agenda, awaitingAdjudication: [decision] }), []);
  assert.notDeepEqual(validateDaemonAgenda({ ...agenda, underReview: [{ ...execution, pinned: "true" }] }), []);
  assert.notDeepEqual(
    validateDaemonAgenda({ ...agenda, awaitingDecision: [{ ...decision, riskTier: "extreme" }] }),
    [],
  );
  // awaitingRework is required now that the mixed shape is gone: omitting it is refused.
  const { awaitingRework: _omit, ...withoutRework } = agenda;
  assert.notDeepEqual(validateDaemonAgenda(withoutRework), []);
  assert.notDeepEqual(validateDaemonAgenda({ ...agenda, undeclaredGroup: [] }), []);
});
