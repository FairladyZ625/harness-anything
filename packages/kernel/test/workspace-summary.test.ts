// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { summarizeWorkspace } from "../src/index.ts";
import type { WorkspaceSummaryDecision, WorkspaceSummaryTask } from "../src/domain/workspace-summary.ts";

test("workspace summary matches list-derived task counts and preserves the blocking overlay", () => {
  const tasks: WorkspaceSummaryTask[] = [
    { status: "planned", blockingState: "blocked" },
    { status: "active", blockingState: "clear" },
    { status: "active", blockingState: "blocked" },
    { status: "in_review", blockingState: "blocked" },
    { status: "done", blockingState: "clear" },
    { status: "cancelled", blockingState: "unknown" }
  ];
  const summary = summarizeWorkspace(tasks, []);
  const projectedStatus = (task: WorkspaceSummaryTask) => task.blockingState === "blocked" && (task.status === "planned" || task.status === "active") ? "blocked" : task.status;

  assert.equal(summary.tasks.total, tasks.length);
  for (const status of ["planned", "active", "blocked", "in_review", "done", "cancelled"] as const) {
    assert.equal(summary.tasks.byStatus[status], tasks.filter((task) => projectedStatus(task) === status).length);
  }
  assert.equal(summary.tasks.byStatus.unknown, 0);
});

test("workspace summary assigns every decision once and keeps proposed and retired meanings exact", () => {
  const decisions: WorkspaceSummaryDecision[] = [
    { decisionId: "dec_proposed", state: "proposed" },
    { decisionId: "dec_effect", state: "in_effect" },
    { decisionId: "dec_rejected", state: "rejected" },
    { decisionId: "dec_deferred", state: "deferred" },
    { decisionId: "dec_superseded", state: "superseded" },
    { decisionId: "dec_retired", state: "outcome_retired" }
  ];
  const summary = summarizeWorkspace([], decisions);
  const group = (id: typeof summary.decisions.groups[number]["id"]) => summary.decisions.groups.find((candidate) => candidate.id === id)!;

  assert.equal(summary.decisions.total, decisions.length);
  assert.equal(summary.decisions.inboxCount, decisions.filter(({ state }) => state === "proposed").length);
  assert.deepEqual(summary.decisions.byState, { proposed: 1, in_effect: 1, rejected: 1, deferred: 1, superseded: 1, outcome_retired: 1 });
  assert.deepEqual(group("proposed"), { id: "proposed", states: ["proposed"], count: 1, decisionIds: ["dec_proposed"] });
  assert.deepEqual(group("retired"), { id: "retired", states: ["superseded", "outcome_retired"], count: 2, decisionIds: ["dec_superseded", "dec_retired"] });
  assert.deepEqual(summary.decisions.groups.flatMap(({ decisionIds }) => decisionIds).sort(), decisions.map(({ decisionId }) => decisionId).sort());
});
