// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";

import { emptyCompletionContract, retiredHostedCiSource } from "../domain/completion.fixtures.ts";
import { lifecycleFixture } from "../store/task-lifecycle-fixture.ts";
import { canonicalGateReceipts, requiredGateWitnessCount } from "../../src/domain/task-lifecycle-contract-support.ts";
import { gateResults } from "../../src/domain/closeout-readiness.ts";
import type { FrozenGateRequirement } from "../../src/domain/completion-contract.ts";

const codeDocGate: FrozenGateRequirement = {
    gateId: "code-doc-reconciliation",
    appliesTo: "code",
    witness: { kind: "internal", adapterId: "code-doc-reconciliation", adapterOptions: {} },
  },
  ciGate: FrozenGateRequirement = {
    gateId: "ci",
    appliesTo: "code",
    witness: {
      ...retiredHostedCiSource,
      adapterId: "github-actions",
      adapterOptions: {
        workflows: ["rewrite-ci"],
        branch: "main",
        event: "push",
        coverage: "exact",
        selection: "newest",
      },
    },
  },
  delivery = { required: true, merged: true, targetBranch: "main", platform: "github" as const };

/** A submitted, consented cut whose frozen contract is the given retired requirement list. */
function retiredCut(...gates: readonly FrozenGateRequirement[]) {
  const fixture = lifecycleFixture({ gates, complete: false }),
    execution = fixture.snapshot.executions[0]!;
  assert.equal(fixture.snapshot.task?.status, "in_review", "the fixture stops at the consented review corridor");
  assert.equal(execution.state, "submitted");
  assert.equal(fixture.snapshot.consents.length, 1);
  return { snapshot: fixture.snapshot, execution };
}

test("a frozen retired requirement reads out of scope and mints no completion receipt", () => {
  for (const [gateId, gate] of [
    ["code-doc-reconciliation", codeDocGate],
    ["ci", ciGate],
  ] as const) {
    const { snapshot, execution } = retiredCut(gate);
    assert.deepEqual(
      gateResults(snapshot, undefined, execution.executionId, execution.submission, execution.iteration, delivery).map(
        ({ gateId: id, status }) => [id, status],
      ),
      [[gateId, gateId === "ci" ? "passed" : "not_applicable"]],
      `${gateId} is explained by its retirement, never by a ledger witness`,
    );
    assert.deepEqual(canonicalGateReceipts(snapshot, execution, delivery), []);
    assert.deepEqual(canonicalGateReceipts(snapshot, execution), [], "no delivery projection still mints no receipt");
  }
});

test("the retired gate set leaves nothing for a completion receipt cut to reference", () => {
  const { snapshot, execution } = retiredCut(ciGate, codeDocGate);
  assert.deepEqual(
    gateResults(snapshot, undefined, execution.executionId, execution.submission, execution.iteration, delivery).map(
      ({ gateId, status }) => [gateId, status],
    ),
    [
      ["ci", "passed"],
      ["code-doc-reconciliation", "not_applicable"],
    ],
  );
  assert.deepEqual(canonicalGateReceipts(snapshot, execution, delivery), []);
});

test("a retired-only contract demands no witness count, with or without a delivery projection", () => {
  const { snapshot, execution } = retiredCut(codeDocGate);
  // Receipts and the required count are one judgment: a gate that mints no receipt cannot be owed one.
  assert.deepEqual(canonicalGateReceipts(snapshot, execution, delivery), []);
  assert.equal(requiredGateWitnessCount(snapshot, execution), 0);
});

test("the closeout gate set of a retired-only contract still parses as frozen history", () => {
  // The fixture froze the same contract a pre-retirement submit would have written; resolution
  // would drop the requirement today, but accepted history must stay readable and completable.
  const { snapshot, execution } = retiredCut(codeDocGate);
  assert.deepEqual(
    execution.submission?.completionContract.gates.map((gate) => gate.gateId),
    ["code-doc-reconciliation"],
  );
  assert.equal(snapshot.task?.completionGateIds.includes("code-doc-reconciliation"), true);
  assert.equal(emptyCompletionContract.gates.length, 0, "the shared fixture contract declares no gate");
});
