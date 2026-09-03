// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import {
  getEntityKindContract,
  projectBaseEntityAtCut,
  requireEntityTypeContract,
  type ActorIdentity,
  type BaseEntity,
  type EntityActionExplanationSetV1,
  type TaskLifecycleSnapshot,
} from "../../kernel/src/index.ts";
import { makeTaskActionExplanationService } from "../src/task-action-explanation-service.ts";
import { lifecycleHarness, owner, reviewer } from "./task-lifecycle-test-harness.ts";

test("Task explanations distinguish lifecycle state, actor capability, invocation input, and authorization", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    const planned = await snapshot(harness),
      oldPlanned = taskCatalogActionIds(),
      plannedOwner = explain(harness, planned, owner),
      plannedStart = row(plannedOwner, "start");
    assert.deepEqual(
      plannedOwner.subjects[0]!.actions.map(({ action }) => action.id),
      [
        "create",
        "start",
        "transition",
        "submit",
        "review",
        "consent",
        "reconcile",
        "repoint",
        "complete",
        "release",
        "amend",
        "archive",
        "supersede",
        "delete",
        "reopen",
        "contract-migrate",
      ],
    );
    assert.equal(plannedStart.available, true);
    assert.deepEqual(
      plannedStart.criteria.map(({ status }) => status),
      ["met", "met", "met"],
    );
    assert.equal(row(plannedOwner, "submit").available, false);
    assert.equal(row(plannedOwner, "review").available, false);
    assert.equal(row(plannedOwner, "complete").available, false);

    await harness.start("execution-1");
    const active = await snapshot(harness),
      oldActive = taskCatalogActionIds(),
      activeOwner = explain(harness, active, owner),
      activeOther = explain(harness, active, reviewer);
    assert.deepEqual(oldActive, oldPlanned, "the old catalog-only explain cannot distinguish lifecycle state");
    assert.notDeepEqual(
      activeOwner.subjects[0]!.actions.map(({ available }) => available),
      plannedOwner.subjects[0]!.actions.map(({ available }) => available),
    );
    const activeStart = row(activeOwner, "start"),
      sameCodeCriteria = activeStart.criteria.filter(({ failureCode }) => failureCode === "invalid_transition");
    assert.deepEqual(
      sameCodeCriteria.map(({ ref, status }) => ({ ref, status })),
      [
        { ref: "task-lifecycle-contract-support/revisionIssues", status: "met" },
        { ref: "task-lifecycle-command-transitions/canStartExecution", status: "unmet" },
      ],
      "criterion identity, not a shared failure code, selects the evaluator",
    );
    assert.deepEqual(
      activeStart.unmetCriteria.filter(({ failureCode }) => failureCode === "invalid_transition").map(({ ref }) => ref),
      ["task-lifecycle-command-transitions/canStartExecution"],
    );
    assert.equal(row(activeOwner, "submit").available, true);
    assert.equal(
      criterion(row(activeOwner, "submit"), "task-lifecycle-command-transitions/submit.validate").status,
      "invocation-required",
    );
    assert.equal(row(activeOther, "submit").available, false);
    assert.equal(criterion(row(activeOther, "submit"), "repo-cell-proof/proofFor.SubmitExecution").status, "unmet");

    const lapsed: TaskLifecycleSnapshot = {
      ...active,
      lease: active.lease ? { ...active.lease, phase: "orphaned" } : null,
    };
    assert.equal(row(explain(harness, lapsed, owner), "submit").available, false);
    assert.equal(row(explain(harness, lapsed, owner), "start").available, false);

    await harness.submit("execution-1");
    const submitted = await snapshot(harness),
      submittedOwner = row(explain(harness, submitted, owner), "submit"),
      independentReview = row(explain(harness, submitted, reviewer), "review"),
      selfReview = row(explain(harness, submitted, owner), "review");
    assert.equal(submittedOwner.available, true);
    assert.match(
      criterion(submittedOwner, "task-lifecycle-command-transitions/submit.validate").nextActions[0] ?? "",
      /--amend/u,
    );
    assert.equal(independentReview.available, true);
    assert.equal(
      criterion(independentReview, "task-lifecycle-review-transitions/review.validate").status,
      "invocation-required",
    );
    assert.equal(selfReview.available, false);
    assert.equal(criterion(selfReview, "repo-cell-proof/proofFor.RecordReview").status, "unmet");

    await harness.review("execution-1", "acceptance", "approved");
    await harness.consent("execution-1");
    const ready = await snapshot(harness),
      ownerComplete = row(explain(harness, ready, owner), "complete"),
      reviewerComplete = row(explain(harness, ready, reviewer), "complete");
    assert.equal(ownerComplete.available, true);
    assert.equal(reviewerComplete.available, false);
    assert.equal(criterion(reviewerComplete, "task-lifecycle-review-transitions/complete.validate").status, "unmet");

    await harness.complete("execution-1");
    const terminal = await snapshot(harness),
      terminalOwner = explain(harness, terminal, owner);
    assert.equal(terminal.task?.status, "done");
    assert.equal(
      terminalOwner.subjects[0]!.actions.filter(({ action }) =>
        ["start", "submit", "review", "complete"].includes(action.id),
      ).every(({ available }) => available === false),
      true,
    );

    const denied = explain(harness, planned, owner, "denied"),
      deniedStart = row(denied, "start");
    assert.equal(deniedStart.available, false);
    assert.deepEqual(deniedStart.unmetCriteria, []);
    assert.deepEqual(deniedStart.authorizationDecision?.reasonCodes, ["role_binding_missing"]);
    assert.equal(new Set(deniedStart.nextActions).size, deniedStart.nextActions.length);
  } finally {
    await harness.cleanup();
  }
});

async function snapshot(harness: ReturnType<typeof lifecycleHarness>): Promise<TaskLifecycleSnapshot> {
  return (await harness.service.read("task-1")).snapshot;
}

function taskCatalogActionIds(): readonly string[] {
  return getEntityKindContract("task")?.actionCatalog?.actions.map(({ id }) => id) ?? [];
}

function explain(
  harness: ReturnType<typeof lifecycleHarness>,
  snapshotValue: TaskLifecycleSnapshot,
  actor: ActorIdentity,
  outcome: "allowed" | "denied" = "allowed",
): EntityActionExplanationSetV1 {
  const event = harness.eventStore
    .read()
    .events.find(({ workspaceRevision }) => workspaceRevision === snapshotValue.revision);
  assert.ok(event);
  assert.ok(snapshotValue.task);
  const entity = projectBaseEntityAtCut<BaseEntity<"task">>(requireEntityTypeContract("task"), {
      kind: "task",
      id: snapshotValue.task.taskId,
      workspaceRevision: snapshotValue.revision,
      occurredAt: event.occurredAt,
      actor: event.actor,
      source: event.source,
      pinned: snapshotValue.task.pinned,
      disposition: snapshotValue.task.packageDisposition ?? "active",
    }),
    cut = `canonical:${snapshotValue.revision}`;
  return makeTaskActionExplanationService({
    actor,
    authorize: ({ target, evaluatedAtCut }) => ({
      policyRef: "default@5",
      actor,
      subject: target,
      bindingsUsed: [],
      outcome,
      reasonCodes: outcome === "allowed" ? [] : ["role_binding_missing"],
      nextActions: outcome === "allowed" ? [] : ["Ask a repository owner to grant a matching RoleBinding."],
      evaluatedAtCut,
    }),
  }).object({ entity, snapshot: snapshotValue, evaluatedAtCut: cut });
}

function row(result: EntityActionExplanationSetV1, id: string) {
  const found = result.subjects[0]!.actions.find(({ action }) => action.id === id);
  assert.ok(found);
  return found;
}

function criterion(result: ReturnType<typeof row>, ref: string) {
  const found = result.criteria.find((candidate) => candidate.ref === ref);
  assert.ok(found);
  return found;
}
