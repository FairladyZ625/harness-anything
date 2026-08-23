// harness-test-tier: fast
// W5:全局「执行证据」列表页撤销——本文件收窄为单 task 的投影适配与上下文拼装
// (Task 详情「收口」页签消费的同一面);跨 task 聚合/过滤/分页随页面删除。
import { describe, expect, it } from "vitest";
import { REPLAY_TASK_GRAPH } from "../../kernel/src/index.ts";
import type { TaskSnapshotProjectionRow } from "../src/api/renderer-dto.ts";
import {
  adaptTaskExecutions,
  buildExecutionEvidenceContext,
} from "../src/renderer/model/execution-evidence.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const DIGEST = `sha256:${"c".repeat(64)}` as const;
const ACTOR = { principal: { personId: "person-owner" }, executor: { kind: "agent" as const, id: "fact-execution-migration" } };

describe("execution evidence model", () => {
  it("uses projected origin and joins witnesses only through the exact execution cut", () => {
    const execution = adaptTaskExecutions(row())[0]!;

    expect(execution.origin).toBe("native");
    expect(execution.reviews.map(({ reviewId }) => reviewId)).toEqual(["review-dismissed", "review-unselected", "review-matching"]);
    expect(execution.consents.map(({ consentId }) => consentId)).toEqual(["consent-matching"]);
    expect({ reviewId: execution.selectedReviewId, consentId: execution.selectedConsentId }).toEqual({ reviewId: "review-matching", consentId: "consent-matching" });
    expect(execution.gateWitnesses.map(({ witnessId }) => witnessId)).toEqual(["gate-matching"]);
    expect(execution.outputs.filter(({ isPassingReceipt }) => isPassingReceipt)).toHaveLength(1);
  });

  it("keeps output receipts separate from execution gate witnesses and exposes missing projection fields", () => {
    const source = row();
    const malformed = {
      ...source,
      executionEvidence: [{ executionId: "execution-1", origin: "archival", outputs: [
        { checkerReceiptRef: null, checkerResult: "unknown" },
      ] }],
      snapshot: {
        ...source.snapshot,
        executions: [{ ...source.snapshot.executions[0]!, submission: {
          ...source.snapshot.executions[0]!.submission!, outputs: ["artifacts/unprojected.txt"],
        } }],
      },
    } as unknown as TaskSnapshotProjectionRow;

    const output = adaptTaskExecutions(malformed)[0]!.outputs[0]!;
    expect(output).toMatchObject({ evidenceId: undefined, locator: undefined, substrate: undefined, checkerReceiptRef: null, checkerResult: "unknown" });
    expect(output.checkerReceiptRef).not.toBe("gate-receipt-matching");
  });

  it("adapts a TaskRow-shaped source (透传字段) the same as a full projection row", () => {
    const source = row();
    const taskRowShaped = {
      taskId: source.taskId,
      updatedAt: source.updatedAt,
      snapshotAvailability: source.snapshotAvailability,
      snapshot: {
        task: { title: source.snapshot.task?.title },
        executions: source.snapshot.executions,
        reviews: source.snapshot.reviews,
        consents: source.snapshot.consents,
        gateWitnesses: source.snapshot.gateWitnesses,
      },
      executionEvidence: source.executionEvidence,
    };
    // rawTask embeds the full TaskV1 only when a full row is passed; the adapted
    // evidence fields (what the closeout tab renders) must be identical.
    const { rawTask: _full, ...fromFull } = adaptTaskExecutions(source)[0]!;
    const { rawTask: _shaped, ...fromShaped } = adaptTaskExecutions(taskRowShaped)[0]!;
    expect(fromShaped).toEqual(fromFull);
  });

  it("copies task, execution, output originals, projected fields, receipt, and copy time", () => {
    const executionRow = adaptTaskExecutions(row())[0]!;
    const context = buildExecutionEvidenceContext(executionRow, executionRow.outputs[0]!, () => "2026-08-14T12:34:56.000Z");

    for (const text of ["task 原文", "execution 原文", "output 原文", "evidenceId", "checkerReceiptRef", "receipt-pass", "2026-08-14T12:34:56.000Z"]) {
      expect(context).toContain(text);
    }
  });
});

function row(overrides: Partial<TaskSnapshotProjectionRow> = {}): TaskSnapshotProjectionRow {
  const taskId = overrides.taskId ?? "task-evidence";
  const base: TaskSnapshotProjectionRow = {
    taskId, packagePath: `tasks/${taskId}`, generation: "v1", workspaceRevision: 9, createdAt: "2026-08-14T08:00:00.000Z", updatedAt: "2026-08-14T09:00:00.000Z",
    snapshot: {
      revision: 9,
      task: { schema: "task/v1", taskId, title: "Evidence truth", taskClass: "standard", status: "in_review", graph: REPLAY_TASK_GRAPH,
        currentNode: "review", iteration: 0, createdBy: ACTOR, completionGateIds: ["build"], presetSnapshotDigest: null },
      executions: [execution("execution-1", 1)],
      reviews: [review("review-dismissed", SHA_A, 0, "dismissed"), review("review-unselected", SHA_A, 0), review("review-matching", SHA_A, 0), review("review-other-cut", SHA_B, 1)],
      consents: [consent("consent-matching", "review-matching"), consent("consent-other-cut", "review-other-cut")],
      codeDocWitnesses: [],
      gateWitnesses: [gate("gate-matching", SHA_A, 0), gate("gate-other-cut", SHA_B, 1)],
      edgesTaken: [], lease: null,
    },
    snapshotAvailability: { consents: "known", codeDocWitnesses: "known", gateWitnesses: "known" },
    closeoutAssessment: { readiness: "incomplete", executionId: "execution-1", blocker: "consent", gates: [{ gateId: "build", status: "passed" }] },
    blockingAssessment: { taskId, state: "clear", blockers: [], warnings: [] },
    placement: { moduleKeys: ["gui"], productLines: ["harness"], parentTaskId: null, origin: "native", engine: "kernel/task-lifecycle/v1",
      packageDisposition: "active", provenance: [{ kind: "canonical-event", ref: `task/${taskId}` }] },
    executionEvidence: [{ executionId: "execution-1", origin: "native", outputs: [
      { evidenceId: `evidence_${"1".repeat(24)}`, locator: "artifacts/result.txt", substrate: "repository-path", checkerReceiptRef: "receipt-pass", checkerResult: "pass" },
      { evidenceId: `evidence_${"2".repeat(24)}`, locator: "https://example.test/log", substrate: "uri", checkerReceiptRef: null, checkerResult: "unknown" },
    ] }],
  };
  return { ...base, ...overrides };
}

function execution(executionId: string, minute: number) {
  return { schema: "execution/v1" as const, executionId, taskId: "task-evidence", nodeId: "implementation" as const, iteration: 0 as const,
    state: "submitted" as const, actor: ACTOR, claimedAt: `2026-08-14T08:${String(minute).padStart(2, "0")}:00.000Z`, submittedAt: `2026-08-14T08:${String(minute).padStart(2, "0")}:30.000Z`, closedAt: null,
    submission: { completionClaim: "Evidence delivered", deliverables: ["result"], outputs: ["artifacts/result.txt", "https://example.test/log"],
      verificationNotes: ["checked"], knownGaps: [], residualRisks: [], commitSha: SHA_A } };
}

function review(reviewId: string, commitSha: string, iteration: 0 | 1, verdict: "approved" | "dismissed" = "approved") {
  return { schema: "review/v1" as const, reviewId, taskId: "task-evidence", executionId: "execution-1", verdict, actor: ACTOR,
    capabilityRef: "capability/review", reason: "verified", evidenceChecked: ["artifacts/result.txt"], commitSha, iteration, contentDigest: DIGEST, reviewedAt: "2026-08-14T08:10:00.000Z" };
}

function consent(consentId: string, reviewId: string) {
  return { schema: "review-consent/v1" as const, consentId, taskId: "task-evidence", executionId: "execution-1", reviewId,
    reviewDigest: DIGEST, contentDigest: DIGEST, actor: ACTOR, source: "local" as const, consentedAt: "2026-08-14T08:11:00.000Z" };
}

function gate(witnessId: string, commitSha: string, iteration: 0 | 1) {
  return { schema: "completion-gate-witness/v1" as const, witnessId, receiptId: witnessId === "gate-matching" ? "gate-receipt-matching" : "gate-receipt-other",
    checkerId: "build", gateId: "build", result: "pass" as const, taskId: "task-evidence", executionId: "execution-1", commitSha, iteration,
    actor: ACTOR, source: "local" as const, verifiedAt: "2026-08-14T08:12:00.000Z" };
}
