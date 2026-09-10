// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { getExecutableEntityAction } from "../../kernel/src/index.ts";
import { makeEntityActionCatalogExecutor, deriveActionResult } from "../src/entity-action-catalog-executor.ts";
import { rejectExecutionSelection } from "../src/repo-cell-execution-selection.ts";
import { cellCriterionError } from "../src/repo-cell-errors.ts";
import { failed } from "../src/repo-cell-settlement.ts";

test("the catalog executor directly invokes Task execution metadata and derives ActionResult", async () => {
  const executor = makeEntityActionCatalogExecutor({
      store: {} as never,
      projection: {} as never,
      now: () => "2026-08-30T00:00:00.000Z",
      sessionIdentity: () => ({ kind: "unavailable", reason: "test" }) as never,
    }),
    receipt = await executor.run(
      { kind: "task-start", taskId: "task_contract", expectedVersion: 4 },
      {} as never,
      "op-contract",
      {
        task: async (contract) => {
          assert.equal(contract.execution.lifecycle?.transitionId, "start_execution");
          return {
            outcome: "applied",
            opId: "op-contract",
            revision: 5,
            evidence: "event:event-5",
            visibility: "center",
            proof: {
              committedRevision: 5,
              appliedCut: 5,
              durable: true,
              canonicalVisible: true,
              worktreeVisible: true,
            },
          };
        },
      },
    );
  assert.deepEqual(receipt.unmetCriteria, []);
  assert.deepEqual(receipt.effects, [
    "task-lifecycle-publication/compileTaskLifecycleWrite",
    "task-lifecycle-transitions/start_execution",
  ]);
  assert.deepEqual(receipt.updatedProjection, { kind: "task", ref: "task/task_contract", revision: 5 });
  assert.equal(receipt.rejectionExplanation, null);
  assert.deepEqual(receipt.nextActions, []);
});

test("rejected Task ActionResult preserves the exact structured criterion", async () => {
  const executor = makeEntityActionCatalogExecutor({
      store: {} as never,
      projection: {} as never,
      now: () => "2026-08-30T00:00:00.000Z",
      sessionIdentity: () => ({ kind: "unavailable", reason: "test" }) as never,
    }),
    receipt = await executor.run({ kind: "task-submit", taskId: "task_contract" }, {} as never, "op-fenced", {
      task: async () => ({
        outcome: "op_rejected",
        opId: "op-fenced",
        code: "invalid_transition",
        origin: "daemon",
        evidence: "rejection:invalid_transition",
        diagnostic: { kind: "failure", code: "invalid_transition" },
        unmetCriteria: [
          {
            ref: "task-lifecycle-contract-support/revisionIssues",
            failureCode: "invalid_transition",
            explain: "The command expectedVersion matches the current Task aggregate revision.",
          },
        ],
      }),
    });
  assert.deepEqual(receipt.unmetCriteria, [
    {
      ref: "task-lifecycle-contract-support/revisionIssues",
      failureCode: "invalid_transition",
      explain: "The command expectedVersion equals the canonical Task projection revision at commit time.",
    },
  ]);
  assert.deepEqual(receipt.effects, []);
  assert.equal(receipt.updatedProjection, null);
  assert.match(receipt.rejectionExplanation ?? "", /expectedVersion/u);
  assert.deepEqual(receipt.nextActions, []);
});

test("ambiguous failure codes do not invent a criterion", async () => {
  const executor = makeEntityActionCatalogExecutor({
      store: {} as never,
      projection: {} as never,
      now: () => "2026-08-30T00:00:00.000Z",
      sessionIdentity: () => ({ kind: "unavailable", reason: "test" }) as never,
    }),
    receipt = await executor.run({ kind: "task-submit", taskId: "task_contract" }, {} as never, "op-ambiguous", {
      task: async () => ({
        outcome: "op_rejected",
        opId: "op-ambiguous",
        code: "invalid_transition",
        origin: "daemon",
        evidence: "rejection:invalid_transition",
        nextAction: "Inspect the Task state.",
      }),
    });
  assert.deepEqual(receipt.unmetCriteria, []);
  assert.doesNotMatch(JSON.stringify(receipt), /criteria\/invalid_transition/u);
});

test("criterion-bearing failures resolve descriptors by action plus ref even when failure codes collide", () => {
  const contract = getExecutableEntityAction("task-start");
  assert.ok(contract);
  for (const criterionRef of [
    "task-lifecycle-contract-support/revisionIssues",
    "task-lifecycle-command-transitions/canStartExecution",
  ]) {
    const descriptor = contract.criteria.find(({ ref }) => ref === criterionRef);
    assert.ok(descriptor);
    const receipt = deriveActionResult(
      contract,
      { kind: "task-start", taskId: "task_contract" },
      failed(
        `op-${criterionRef}`,
        cellCriterionError("invalid_transition", "Retry from the validator result.", "start", criterionRef, [
          "Retry from the validator result.",
        ]),
        contract,
        { kind: "task-start", taskId: "task_contract" },
      ),
    );
    assert.deepEqual(receipt.unmetCriteria, [descriptor]);
  }
});

test("a plain coded-error rejection forwards the guard's own message instead of the generic sentence", () => {
  const contract = getExecutableEntityAction("task-complete");
  assert.ok(contract);
  const receipt = deriveActionResult(
    contract,
    { kind: "task-complete", taskId: "task_contract" },
    failed(
      "op-preset-mismatch",
      Object.assign(new Error("Run ha preset upgrade task_contract before completion."), {
        code: "preset_snapshot_mismatch",
      }),
    ),
  );
  assert.equal(receipt.code, "preset_snapshot_mismatch");
  assert.equal(receipt.rejectionExplanation, "Run ha preset upgrade task_contract before completion.");
});

test("symptom task_4ba380067767eb1d0744ba7844: ambiguous execution selection names its candidates instead of a bare invalid_command", () => {
  const contract = getExecutableEntityAction("task-review-execution");
  assert.ok(contract);
  let thrown: unknown;
  try {
    rejectExecutionSelection(
      [{ executionId: "exec-changes-requested" }, { executionId: "exec-submitted" }],
      "Current submitted execution",
      "Run ha task show task_contract; if the task is active, run ha task submit task_contract " +
        "--json-input '<submission-json>'.",
      (candidate) =>
        `ha task review-execution task_contract --execution-id ${candidate} ` +
        "--review-id <review-id> --from-file <review.json>",
    );
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, "rejectExecutionSelection must throw for multiple candidates");
  const receipt = deriveActionResult(
    contract,
    { kind: "task-review-execution", taskId: "task_contract" },
    failed("op-ambiguous-review", thrown),
  );
  assert.equal(receipt.code, "invalid_command");
  assert.match(String(receipt.rejectionExplanation), /candidates: exec-changes-requested, exec-submitted/u);
  assert.match(String(receipt.rejectionExplanation), /Choose one explicitly/u);
});
