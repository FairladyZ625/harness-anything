// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_TASK_WIP_LIMIT, admitTaskExecutionWip, parseTaskWipLimit } from "../../src/index.ts";
import { enteringExecutionWip, hasCloseoutEvidence, isExecutionWipTask, type TaskWipSnapshotEntryV1 } from "../../src/domain/task-wip-policy.ts";

const entry = (overrides: Partial<TaskWipSnapshotEntryV1> = {}): TaskWipSnapshotEntryV1 => ({ taskId: "task_X", title: "X", status: "active", taskClass: "standard", packageDisposition: "active", hasCloseoutEvidence: false, directChildCount: 0, ...overrides });

test("the default limit is 30 and the count admits work below it", () => {
  assert.equal(DEFAULT_TASK_WIP_LIMIT, 30);
  const tasks = Array.from({ length: 29 }, (_, index) => entry({ taskId: `task_OCC_${index}`, status: "active" }));
  assert.deepEqual(admitTaskExecutionWip({ limit: DEFAULT_TASK_WIP_LIMIT, limitLabel: "settings.tasks.wipLimit", tasks, activatingTaskId: "task_NEW", nextStatus: "active" }), { ok: true });
});

test("an exactly full worktable rejects a new activation with the counting criteria in the message", () => {
  const tasks = [
    ...Array.from({ length: DEFAULT_TASK_WIP_LIMIT - 1 }, (_, index) => entry({ taskId: `task_OCC_${index}`, status: "active", title: `Occupying ${index}` })),
    entry({ taskId: "task_BLOCKED", title: "Blocked", status: "blocked" }),
    entry({ taskId: "task_NEW", status: "planned", title: "New work" })
  ];
  const admission = admitTaskExecutionWip({ limit: DEFAULT_TASK_WIP_LIMIT, limitLabel: "settings.tasks.wipLimit", tasks, activatingTaskId: "task_NEW", nextStatus: "active" });
  assert.equal(admission.ok, false);
  if (admission.ok) return;
  assert.equal(admission.code, "TASK_WIP_LIMIT_REACHED");
  assert.match(admission.message, /TASK_WIP_LIMIT_REACHED: Execution worktable is full \(30\/30; settings\.tasks\.wipLimit=30\)/u);
  assert.match(admission.message, /Suggested: task_BLOCKED "Blocked" \(blocked\)/u);
  assert.match(admission.message, /ha task start task_NEW/u);
});

test("only occupying statuses on active standard packages count; ideas, containers, and dispositions never do", () => {
  assert.equal(isExecutionWipTask(entry({ status: "active" })), true);
  assert.equal(isExecutionWipTask(entry({ status: "blocked" })), true);
  assert.equal(isExecutionWipTask(entry({ status: "in_review" })), true);
  assert.equal(isExecutionWipTask(entry({ status: "planned" })), false);
  assert.equal(isExecutionWipTask(entry({ status: "done" })), false);
  assert.equal(isExecutionWipTask(entry({ status: "cancelled" })), false);
  assert.equal(isExecutionWipTask(entry({ status: "active", packageDisposition: "archived" })), false);
  assert.equal(isExecutionWipTask(entry({ status: "active", packageDisposition: "tombstoned" })), false);
  assert.equal(isExecutionWipTask(entry({ status: "active", taskClass: "milestone" })), false);
  assert.equal(isExecutionWipTask(entry({ status: "active", taskClass: "epic" })), false);
  const full = Array.from({ length: 30 }, (_, index) => entry({ taskId: `task_OCC_${index}` }));
  const idea = entry({ taskId: "task_IDEA", status: "planned", title: "Idea" });
  const gated = admitTaskExecutionWip({ limit: 30, limitLabel: "settings.tasks.wipLimit", tasks: [...full, idea], activatingTaskId: "task_IDEA", nextStatus: "active" });
  assert.equal(gated.ok, false, "activating an idea into a full worktable is still new work");
  for (const extra of [entry({ taskId: "task_MILESTONE", status: "planned", taskClass: "milestone" }), entry({ taskId: "task_EPIC", status: "planned", taskClass: "epic" }), entry({ taskId: "task_ARCHIVED", status: "planned", packageDisposition: "archived" }), entry({ taskId: "task_TOMBSTONED", status: "planned", packageDisposition: "tombstoned" })]) {
    const admission = admitTaskExecutionWip({ limit: 30, limitLabel: "settings.tasks.wipLimit", tasks: [...full, extra], activatingTaskId: extra.taskId, nextStatus: "active" });
    assert.equal(admission.ok, true, `${extra.taskId} never enters the worktable, so the gate must not hold it`);
  }
});

test("structure-derived roots do not occupy WIP, preserve the declared taskClass, and honor both threshold boundaries", () => {
  const threeChildren = entry({ directChildCount: 3 });
  assert.equal(isExecutionWipTask(threeChildren), false, "3 direct children reaches the default threshold and derives root");
  assert.equal(threeChildren.taskClass, "standard", "derivation never rewrites the operator declaration");
  assert.equal(isExecutionWipTask(entry({ directChildCount: 2 })), true, "2 direct children remains a leaf at the default threshold");
  assert.equal(isExecutionWipTask(entry({ directChildCount: 4 }), 5), true, "4 direct children remains a leaf when threshold is raised to 5");
  assert.equal(isExecutionWipTask(entry({ directChildCount: 5 }), 5), false, "5 direct children reaches the configured threshold");
});

test("entering the worktable is the only gated move; re-entering an occupied slot adds nothing", () => {
  assert.equal(enteringExecutionWip(entry({ status: "planned" }), "active"), true);
  assert.equal(enteringExecutionWip(entry({ status: "planned" }), "blocked"), true);
  assert.equal(enteringExecutionWip(entry({ status: "active" }), "active"), false);
  assert.equal(enteringExecutionWip(entry({ status: "in_review" }), "active"), false);
  assert.equal(enteringExecutionWip(entry({ status: "planned", taskClass: "milestone" }), "active"), false);
  const full = Array.from({ length: 30 }, (_, index) => entry({ taskId: `task_OCC_${index}` }));
  const busy = entry({ taskId: "task_BUSY", status: "in_review" });
  assert.deepEqual(admitTaskExecutionWip({ limit: 30, limitLabel: "L", tasks: [...full, busy], activatingTaskId: "task_BUSY", nextStatus: "active" }), { ok: true });
});

test("the kty-web deadlock stays broken: a full worktable still admits a closeout backfill", () => {
  const full = Array.from({ length: 30 }, (_, index) => entry({ taskId: `task_OCC_${index}`, status: "active" }));
  const backfill = entry({ taskId: "task_BACKFILL", status: "planned", hasCloseoutEvidence: true });
  assert.deepEqual(admitTaskExecutionWip({ limit: 30, limitLabel: "settings.tasks.wipLimit", tasks: [...full, backfill], activatingTaskId: "task_BACKFILL", nextStatus: "active" }), { ok: true });
  const withoutEvidence = admitTaskExecutionWip({ limit: 30, limitLabel: "settings.tasks.wipLimit", tasks: [...full, entry({ taskId: "task_FRESH", status: "planned" })], activatingTaskId: "task_FRESH", nextStatus: "active" });
  assert.equal(withoutEvidence.ok, false);
});

test("long_running work has no natural endpoint and never occupies the execution worktable (dec_01KYRHP8ND)", () => {
  const resident = entry({ taskId: "task_RESIDENT", status: "active", taskClass: "long_running" });
  assert.equal(isExecutionWipTask(resident), false);
  assert.equal(enteringExecutionWip(resident, "active"), false);
  assert.equal(enteringExecutionWip(entry({ taskId: "task_RESIDENT", status: "planned", taskClass: "long_running" }), "active"), false);
  // Occupancy is driven by taskClass alone: a full standard worktable still starts resident work.
  const full = Array.from({ length: 30 }, (_, index) => entry({ taskId: `task_OCC_${index}`, status: "active" }));
  assert.deepEqual(admitTaskExecutionWip({ limit: 30, limitLabel: "settings.tasks.wipLimit", tasks: [...full, resident], activatingTaskId: "task_RESIDENT", nextStatus: "active" }), { ok: true });
});

test("delivery evidence is canonical: submitted native executions and migrated archived records", () => {
  const actor = { principal: { personId: "person" }, executor: null };
  assert.equal(hasCloseoutEvidence([]), false);
  assert.equal(hasCloseoutEvidence([{ schema: "execution/v1", executionId: "e", taskId: "task_X", nodeId: "implementation", iteration: 0, state: "active", actor, claimedAt: "2026-08-16T00:00:00.000Z", submittedAt: null, closedAt: null, submission: null }]), false);
  const submission = { completionClaim: "delivered", deliverables: [], outputs: [], verificationNotes: [], knownGaps: [], residualRisks: [], commitSha: "0".repeat(40) };
  assert.equal(hasCloseoutEvidence([{ schema: "execution/v1", executionId: "e", taskId: "task_X", nodeId: "implementation", iteration: 0, state: "submitted", actor, claimedAt: "2026-08-16T00:00:00.000Z", submittedAt: "2026-08-16T01:00:00.000Z", closedAt: null, submission }]), true);
  const archivedBase = { schema: "archived-execution/v1" as const, generation: "v0" as const, migratedFrom: "legacy-e", executionId: "legacy-e", taskId: "task_X", nodeId: "implementation" as const, iteration: 0 as const, state: "submitted" as const, actor, claimedAt: "2026-08-16T00:00:00.000Z", submittedAt: "2026-08-16T01:00:00.000Z", closedAt: null, sessionBindings: [], submission: null };
  assert.equal(hasCloseoutEvidence([{ ...archivedBase, outputs: [], archivedSubmission: null }]), false);
  assert.equal(hasCloseoutEvidence([{ ...archivedBase, outputs: [{ migratedFrom: "ev", locator: "harness/tasks/task_X/INDEX.md", substrate: "repository-path" as const, checkerReceiptRef: null, checkerResult: "unknown" as const }], archivedSubmission: null }]), true);
  assert.equal(hasCloseoutEvidence([{ ...archivedBase, outputs: [], archivedSubmission: { completionClaim: "delivered", deliverables: [], evidenceRefs: [], verificationNotes: [], knownGaps: [], residualRisks: [] } }]), true);
});

test("limit parsing accepts digits and numbers, rejects everything else", () => {
  assert.equal(parseTaskWipLimit(30), 30);
  assert.equal(parseTaskWipLimit("30"), 30);
  assert.equal(parseTaskWipLimit(0), undefined);
  assert.equal(parseTaskWipLimit(-1), undefined);
  assert.equal(parseTaskWipLimit(1.5), undefined);
  assert.equal(parseTaskWipLimit("thirty"), undefined);
  assert.equal(parseTaskWipLimit(""), undefined);
  assert.equal(parseTaskWipLimit(null), undefined);
});

test("an invalid limit fails closed instead of disabling the gate", () => {
  const admission = admitTaskExecutionWip({ limit: Number.NaN, limitLabel: "settings.tasks.wipLimit", tasks: [], activatingTaskId: "task_X", nextStatus: "active" });
  assert.equal(admission.ok, false);
  if (admission.ok) return;
  assert.match(admission.message, /TASK_WIP_POLICY_INVALID/u);
});
