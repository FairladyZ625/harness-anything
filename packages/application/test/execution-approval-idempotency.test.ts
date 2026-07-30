// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { makeReviewExecutionService } from "../src/index.ts";
import {
  makeMarkdownArtifactStore,
  taskHolderActor,
  type WriteCoordinator,
  type WriteOp
} from "../../kernel/src/index.ts";
import { runEffect } from "./effect-test-helpers.ts";

const taskId = "task_01KYSK00000000000000000001";
const executionId = "exe_01KYSK00000000000000000001";
const reviewedAt = "2026-07-30T00:00:00.000Z";
const reviewer = taskHolderActor({ personId: "owner" }, { kind: "agent", id: "ceo" });
const reviewerSession = {
  runtime: "codex" as const,
  sessionId: "approval-idempotency",
  source: "runtime" as const,
  detectedAt: reviewedAt
};

test("retrying approval against a stale read snapshot reuses one Review and consent write identity", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-approval-idempotency-"));
  try {
    seedSubmittedTask(rootDir);
    const liveArtifactStore = makeMarkdownArtifactStore({ rootDir });
    const staleTask = await runEffect(liveArtifactStore.readTaskPackage(taskId));
    const staleArtifactStore = { readTaskPackage: () => Effect.succeed(staleTask) };
    const captured = captureCoordinator();
    const input = {
      taskId,
      executionId,
      reviewer,
      reviewerSession,
      findings: "The submitted evidence is complete.",
      evidenceChecked: [],
      rationale: "The exact delivery satisfies the task.",
      verdict: "approved" as const,
      archiveWarningsAcknowledged: false,
      consentAssertedRationale: "Approval was received through an external channel."
    };
    const approve = () => makeReviewExecutionService({
      rootInput: rootDir,
      coordinator: captured.coordinator,
      artifactStore: staleArtifactStore
    }).reviewExecution(input);

    const first = await approve();
    const retried = await approve();

    assert.equal(retried.review.review_id, first.review.review_id);
    assert.equal(new Set(captured.ops.map((op) => op.opId)).size, 1);
    assert.equal(new Set(captured.ops.map((op) => op.entityId)).size, 1);
    const consentPaths = captured.ops.flatMap((op) => {
      const payload = op.payload as {
        readonly companionWrites?: ReadonlyArray<{ readonly path: string }>;
      };
      return payload.companionWrites?.map((write) => write.path)
        .filter((candidate) => candidate.startsWith("consents/")) ?? [];
    });
    assert.equal(consentPaths.length, 2);
    assert.equal(new Set(consentPaths).size, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("stable approval ids ignore transport-only reviewer metadata", async () => {
  const enrichedReviewer = taskHolderActor({
    personId: "owner",
    displayName: "Owner",
    primaryEmail: "owner@example.test",
    providerId: "transport-derived/v1",
    credential: { kind: "unix-socket-owner-boundary", issuer: "host:test", subject: "501" }
  }, { kind: "agent", id: "ceo" });
  const identities = [];
  for (const approvalReviewer of [reviewer, enrichedReviewer]) {
    const rootDir = mkdtempSync(path.join(tmpdir(), "ha-approval-stable-identity-"));
    try {
      seedSubmittedTask(rootDir);
      const captured = captureCoordinator();
      await makeReviewExecutionService({
        rootInput: rootDir,
        coordinator: captured.coordinator,
        artifactStore: makeMarkdownArtifactStore({ rootDir })
      }).reviewExecution({
        taskId,
        executionId,
        reviewer: approvalReviewer,
        reviewerSession,
        findings: "The submitted evidence is complete.",
        evidenceChecked: [],
        rationale: "The exact delivery satisfies the task.",
        verdict: "approved",
        archiveWarningsAcknowledged: false,
        consentAssertedRationale: "Approval was received through an external channel."
      });
      const op = captured.ops[0]!;
      const companionWrites = (op.payload as {
        readonly companionWrites?: ReadonlyArray<{ readonly path: string }>;
      }).companionWrites ?? [];
      identities.push({
        opIdPrefix: op.opId.slice(0, "approval-".length + 24),
        entityId: op.entityId,
        consentPath: companionWrites.find((write) => write.path.startsWith("consents/"))?.path
      });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  }

  assert.deepEqual(identities[1], identities[0]);
});

function seedSubmittedTask(rootDir: string): void {
  const taskRoot = path.join(rootDir, "harness/tasks", taskId);
  mkdirSync(path.join(taskRoot, "executions"), { recursive: true });
  writeFileSync(path.join(taskRoot, "INDEX.md"), [
    "---",
    "schema: task/v1",
    `task_id: ${taskId}`,
    "title: Approval idempotency",
    "lifecycle:",
    "  status: in_review",
    "  engine: local",
    "---",
    ""
  ].join("\n"), "utf8");
  writeFileSync(path.join(taskRoot, "executions", `${executionId}.md`), `${JSON.stringify({
    schema: "execution/v2",
    execution_id: executionId,
    task_ref: `task/${taskId}`,
    state: "submitted",
    primary_actor: reviewer,
    claimed_at: reviewedAt,
    submitted_at: reviewedAt,
    closed_at: null,
    session_bindings: [],
    outputs: [],
    submission: {
      completion_claim: "The delivery is ready for owner approval.",
      deliverables: ["approval idempotency"],
      evidence_refs: [],
      verification_notes: ["targeted tests passed"],
      known_gaps: [],
      residual_risks: []
    }
  }, null, 2)}\n`, "utf8");
}

function captureCoordinator(): { readonly coordinator: WriteCoordinator; readonly ops: WriteOp[] } {
  const ops: WriteOp[] = [];
  return {
    ops,
    coordinator: {
      enqueue: (op) => Effect.sync(() => {
        ops.push(op);
        return { opId: op.opId, entityId: op.entityId, accepted: true };
      }),
      flush: (reason) => Effect.succeed({ reason, opCount: ops.length, committed: false }),
      recover: Effect.succeed({ replayedOps: 0 })
    }
  };
}
