// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalGateReceipts,
  completionBlockers,
  requiredGateWitnessCount,
  type TaskLifecycleSnapshot,
} from "../../kernel/src/index.ts";

const actor = { principal: { personId: "owner" }, executor: { kind: "agent" as const, id: "worker" } };

function snapshot(commitSha: string | null): TaskLifecycleSnapshot {
  return {
    revision: 5,
    task: {
      taskId: "task-artifact-only",
      title: "Artifact-only delivery",
      status: "in_review",
      currentNode: "review",
      iteration: 0,
      completionGateIds: ["ci", "code-doc-reconciliation"],
      createdBy: actor,
      taskClass: "standard",
      presetSnapshotDigest: null,
    },
    executions: [
      {
        schema: "execution/v1",
        executionId: "execution-1",
        taskId: "task-artifact-only",
        nodeId: "implementation",
        iteration: 0,
        state: "submitted",
        actor,
        claimedAt: "2026-09-14T00:00:00.000Z",
        submittedAt: "2026-09-14T00:01:00.000Z",
        closedAt: null,
        submission: {
          commitSha,
          ...(commitSha === null
            ? {
                artifacts: [
                  { path: "tasks/task-artifact-only/artifacts/report.md", revision: 4, blobSha256: "a".repeat(64) },
                ],
              }
            : {}),
          completionClaim: "Delivered the requested cut.",
          deliverables: ["packages/daemon/src/live.ts"],
          outputs: [],
          verificationNotes: ["Verified."],
          knownGaps: [],
          residualRisks: [],
          completionContract: {
            gates: [
              {
                gateId: "ci",
                appliesTo: "code",
                witness: {
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
              {
                gateId: "code-doc-reconciliation",
                appliesTo: "code",
                witness: { adapterId: "code-doc-reconciliation", adapterOptions: {} },
              },
            ],
          },
        },
      },
    ],
    reviews: [],
    consents: [],
    codeDocWitnesses: [],
    gateWitnesses: [],
    edgesTaken: [],
    lease: null,
  };
}

test("artifact-only cuts skip code-cut gates while commit cuts retain both", () => {
  const context = {
      closeout: "ready" as const,
      closeoutPath: "tasks/task-artifact-only/closeout.md",
      eligibleDirtyPaths: [],
      producesFactCount: 1,
      closeoutGates: { review: false, consent: false, fact: true, factDisposition: false, codeDoc: true },
    },
    artifactOnly = snapshot(null),
    committed = snapshot("b".repeat(40));
  assert.deepEqual(completionBlockers(artifactOnly, "execution-1", context), []);
  assert.equal(requiredGateWitnessCount(artifactOnly, artifactOnly.executions[0]!), 0);
  assert.deepEqual(canonicalGateReceipts(artifactOnly, artifactOnly.executions[0]!), []);
  assert.equal(completionBlockers(committed, "execution-1", context)[0]?.code, "ci_missing");
  assert.equal(requiredGateWitnessCount(committed, committed.executions[0]!), 2);
});
