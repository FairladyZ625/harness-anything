// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTaskLifecycleCommand } from "@harness-anything/kernel";

import { emptyCompletionContract } from "../../kernel/test/domain/completion.fixtures.ts";
import { implementer, lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";
import { completeProof } from "../src/repo-cell-proof.ts";
import type { RepoCellBinding, Snapshot } from "../src/repo-cell-types.ts";

const binding = {
  actor: implementer,
  source: "local",
  authorizationDecision: {
    policyRef: "policy@1",
    actor: implementer,
    subject: "task/task-1",
    bindingsUsed: [],
    outcome: "allowed",
    reasonCodes: [],
    nextActions: [],
    evaluatedAtCut: "cut-1",
  },
} as unknown as RepoCellBinding;

/** The read-side projection `completeProof` needs only for repository delivery policy. */
const projection = {
  getEntity: (kind: string, id: string) =>
    kind === "settings" && id === "repository"
      ? { value: { delivery: { requireMerged: true, targetBranch: "main", platform: "github" } } }
      : null,
  readPresetSnapshot: () => ({ status: "ready", snapshot: { profile: { outputShape: "repository-diff" } } }),
} as unknown as Parameters<typeof completeProof>[3];

/** A submitted, consented cut whose frozen contract is the retired code/doc witness alone. */
function retiredCodeDocCut(): Snapshot {
  const fixture = lifecycleFixture({
    gates: [
      {
        gateId: "code-doc-reconciliation",
        appliesTo: "code",
        witness: { kind: "internal", adapterId: "code-doc-reconciliation", adapterOptions: {} },
      },
    ],
    complete: false,
  });
  assert.equal(fixture.snapshot.task?.status, "in_review");
  assert.deepEqual(
    fixture.snapshot.executions[0]?.submission?.completionContract.gates.map((gate) => gate.gateId),
    ["code-doc-reconciliation"],
  );
  return fixture.snapshot as unknown as Snapshot;
}

/** The same cut with one live gate that never landed a witness: the negative control. */
function liveGateCut(): Snapshot {
  const base = retiredCodeDocCut(),
    execution = base.executions[0]!;
  return {
    ...base,
    task: { ...base.task!, completionGateIds: ["lint"] },
    executions: [
      {
        ...execution,
        submission: {
          ...execution.submission!,
          completionContract: {
            ...execution.submission!.completionContract,
            gates: [
              {
                gateId: "lint",
                appliesTo: "code",
                witness: {
                  adapterId: "research/check",
                  kind: "command",
                  predicateType: "research/v1",
                  resultSchema: { type: "object" },
                  adapterOptions: {},
                },
              },
            ],
          },
        },
      },
    ],
  } as unknown as Snapshot;
}

function completeCommand(snapshot: Snapshot) {
  return {
    ...normalizeTaskLifecycleCommand(
      {
        workspaceId: "workspace-1",
        actor: implementer,
        source: "local",
        expectedRevision: snapshot.revision,
      },
      { type: "CompleteTask", taskId: "task-1", executionId: "execution-1" },
    ),
    eventId: "event-complete-retired-code-doc",
    workspaceRevision: snapshot.revision + 1,
    occurredAt: "2026-10-23T08:00:00.000Z",
  };
}

test("a frozen code/doc requirement never blocks completion proof on a ledger witness", () => {
  const snapshot = retiredCodeDocCut(),
    proof = completeProof(completeCommand(snapshot), snapshot, binding, projection, undefined);
  // The gate is retired: it is explained by retirement, not by a copied witness, so the proof
  // carries no receipt for it and completion proceeds.
  assert.deepEqual(proof.gateReceipts, []);
  assert.deepEqual(proof.delivery, {
    required: true,
    merged: null,
    targetBranch: "main",
  });
  assert.equal(proof.capability, "task-complete@v1");
});

test("a retired code/doc requirement stays visible as an out-of-scope gate, not a passing one", () => {
  const snapshot = retiredCodeDocCut(),
    proof = completeProof(completeCommand(snapshot), snapshot, binding, projection, undefined);
  assert.equal(
    proof.gateReceipts.some(({ gateId }) => gateId === "code-doc-reconciliation"),
    false,
    "an out-of-scope gate must never be reported as a passed receipt",
  );
  assert.equal(emptyCompletionContract.gates.length, 0);
});

test("a live gate without a witness still blocks, so retirement did not widen into a blanket skip", () => {
  const snapshot = liveGateCut();
  // The fix must only excuse gates that are actually retired: the same proof path, one live gate,
  // still refuses.
  assert.throws(
    () => completeProof(completeCommand(snapshot), snapshot, binding, projection, undefined),
    (error: unknown) => (error as { readonly code?: string }).code === "gate_witness_missing",
  );
});
