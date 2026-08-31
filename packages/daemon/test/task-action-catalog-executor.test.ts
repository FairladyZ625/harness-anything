// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { makeEntityActionCatalogExecutor } from "../src/entity-action-catalog-executor.ts";

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
        nextAction: "Refresh the Task projection and retry with its current revision.",
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
      explain: "The command expectedVersion matches the current Task aggregate revision.",
    },
  ]);
  assert.deepEqual(receipt.effects, []);
  assert.equal(receipt.updatedProjection, null);
  assert.match(receipt.rejectionExplanation ?? "", /expectedVersion/u);
  assert.deepEqual(receipt.nextActions, ["Refresh the Task projection and retry with its current revision."]);
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
