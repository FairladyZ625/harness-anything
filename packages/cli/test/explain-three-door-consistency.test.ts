// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { makeTaskActionExplanationService } from "../../application/src/task-action-explanation-service.ts";
import { lifecycleHarness, owner } from "../../application/test/task-lifecycle-test-harness.ts";
import { deriveActionResult } from "../../daemon/src/entity-action-catalog-executor.ts";
import {
  getExecutableEntityAction,
  projectBaseEntityAtCut,
  requireEntityTypeContract,
  type BaseEntity,
} from "../../kernel/src/index.ts";
import { projectedTaskActionHelpRows } from "../src/cli/task-action-help.ts";

test("help, object explain, and rejected ActionResult preserve one Task Action row", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    await harness.start("execution-1");
    const snapshot = (await harness.service.read("task-1")).snapshot,
      event = harness.eventStore.read().events.find(({ workspaceRevision }) => workspaceRevision === snapshot.revision);
    assert.ok(snapshot.task);
    assert.ok(event);
    const cut = `canonical:${snapshot.revision}`,
      entity = projectBaseEntityAtCut<BaseEntity<"task">>(requireEntityTypeContract("task"), {
        kind: "task",
        id: snapshot.task.taskId,
        workspaceRevision: snapshot.revision,
        occurredAt: event.occurredAt,
        actor: event.actor,
        source: event.source,
        pinned: snapshot.task.pinned,
        disposition: snapshot.task.packageDisposition ?? "active",
      }),
      explanation = makeTaskActionExplanationService({
        actor: owner,
        authorize: ({ target, evaluatedAtCut }) => ({
          policyRef: "default@5",
          actor: owner,
          subject: target,
          bindingsUsed: [],
          outcome: "allowed",
          reasonCodes: [],
          nextActions: [],
          evaluatedAtCut,
        }),
      }).object({ entity, snapshot, evaluatedAtCut: cut }),
      row = explanation.subjects[0]?.actions.find(({ action }) => action.id === "start"),
      contract = getExecutableEntityAction("task-start"),
      help = projectedTaskActionHelpRows().find(({ usage }) => usage.startsWith("ha task start "));
    assert.ok(row);
    assert.ok(contract);
    assert.ok(help);
    const firstUnmet = row.unmetCriteria[0];
    assert.ok(firstUnmet);
    assert.equal(row.available, false);
    assert.equal(help.summary, row.action.explain);
    assert.equal(help.usage, row.action.syntax.usage);

    const failure = deriveActionResult(
      contract,
      { kind: "task-start", taskId: "task-1" },
      {
        outcome: "op_rejected",
        opId: "op-three-door",
        code: firstUnmet.failureCode,
        origin: "daemon",
        evidence: "rejection:capability",
        authorizationDecision: row.authorizationDecision!,
        unmetCriteria: row.unmetCriteria,
        rejectionExplanation: firstUnmet.explain,
        nextActions: row.nextActions,
      },
    );
    assert.deepEqual(failure.unmetCriteria, row.unmetCriteria);
    assert.deepEqual(failure.authorizationDecision, row.authorizationDecision);
    assert.deepEqual(failure.nextActions, row.nextActions);
    assert.equal(failure.rejectionExplanation, firstUnmet.explain);
  } finally {
    harness.cleanup();
  }
});
