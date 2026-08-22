// harness-test-tier: fast
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { REPLAY_TASK_GRAPH } from "../../kernel/src/index.ts";
import type { TaskSnapshotProjectionRow } from "../src/api/renderer-dto.ts";
import {
  EXECUTION_EVIDENCE_PAGE_SIZE,
  aggregateExecutionEvidence,
  buildExecutionEvidenceContext,
  filterExecutionEvidence,
  paginateExecutionEvidence,
} from "../src/renderer/model/execution-evidence.ts";
import { ExecutionEvidenceView } from "../src/renderer/views/ExecutionEvidenceView.tsx";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const DIGEST = `sha256:${"c".repeat(64)}` as const;
const ACTOR = { principal: { personId: "person-owner" }, executor: { kind: "agent" as const, id: "fact-execution-migration" } };

describe("execution evidence model", () => {
  it("uses projected origin and joins witnesses only through the exact execution cut", () => {
    const model = aggregateExecutionEvidence([row()]);
    const execution = model.executions[0]!;

    expect(execution.origin).toBe("native");
    expect(execution.reviews.map(({ reviewId }) => reviewId)).toEqual(["review-dismissed", "review-unselected", "review-matching"]);
    expect(execution.consents.map(({ consentId }) => consentId)).toEqual(["consent-matching"]);
    expect({ reviewId: execution.selectedReviewId, consentId: execution.selectedConsentId }).toEqual({ reviewId: "review-matching", consentId: "consent-matching" });
    expect(execution.gateWitnesses.map(({ witnessId }) => witnessId)).toEqual(["gate-matching"]);
    expect(model.stats).toEqual({
      executions: 1,
      tasksWithExecutions: 1,
      outputs: 2,
      nativeExecutions: 1,
      archivalExecutions: 0,
      unknownOriginExecutions: 0,
      passingReceiptOutputs: 1,
    });
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

    const output = aggregateExecutionEvidence([malformed]).executions[0]!.outputs[0]!;
    expect(output).toMatchObject({ evidenceId: undefined, locator: undefined, substrate: undefined, checkerReceiptRef: null, checkerResult: "unknown" });
    expect(output.checkerReceiptRef).not.toBe("gate-receipt-matching");
  });

  it("filters by output receipt and explicit origin, then paginates a stable 25-execution order", () => {
    const executions = Array.from({ length: 26 }, (_, index) => execution(`execution-${String(index).padStart(2, "0")}`, index));
    const source = row({
      snapshot: { ...row().snapshot, executions },
      executionEvidence: executions.map((item, index) => ({
        executionId: item.executionId,
        origin: index % 2 === 0 ? "native" as const : "archival" as const,
        outputs: [{ evidenceId: `evidence_${String(index).padStart(24, "0")}`, locator: `output-${index}.txt`, substrate: "repository-path" as const,
          checkerReceiptRef: index % 3 === 0 ? `receipt-${index}` : null, checkerResult: index % 3 === 0 ? "pass" as const : "unknown" as const }],
      })),
    });
    const model = aggregateExecutionEvidence([source]);

    expect(EXECUTION_EVIDENCE_PAGE_SIZE).toBe(25);
    expect(paginateExecutionEvidence(model.executions, 0)).toMatchObject({ pageNumber: 1, totalPages: 2, hasNextPage: true });
    expect(paginateExecutionEvidence(model.executions, 0).executions).toHaveLength(25);
    expect(paginateExecutionEvidence(model.executions, 1).executions).toHaveLength(1);
    expect(model.executions.map(({ executionId }) => executionId).slice(0, 3)).toEqual(["execution-25", "execution-24", "execution-23"]);
    expect(filterExecutionEvidence(model.executions, { receipt: "passing", origin: "archival" })
      .every((item) => item.origin === "archival" && item.outputs.some((output) => output.isPassingReceipt))).toBe(true);
    expect(filterExecutionEvidence(model.executions, { receipt: "no-receipt", origin: "native" })
      .every((item) => item.origin === "native" && item.outputs.some((output) => output.checkerReceiptRef === null))).toBe(true);
  });

  it("copies task, execution, output originals, projected fields, receipt, and copy time", () => {
    const executionRow = aggregateExecutionEvidence([row()]).executions[0]!;
    const context = buildExecutionEvidenceContext(executionRow, executionRow.outputs[0]!, () => "2026-08-14T12:34:56.000Z");

    for (const text of ["task 原文", "execution 原文", "output 原文", "evidenceId", "checkerReceiptRef", "receipt-pass", "2026-08-14T12:34:56.000Z"]) {
      expect(context).toContain(text);
    }
  });
});

describe("ExecutionEvidenceView", () => {
  it("renders stats, filters, compact output summaries, explicit unknown, and separate execution witnesses", () => {
    const source = row();
    const malformed = { ...source, executionEvidence: [{ executionId: "execution-1", origin: "native", outputs: [
      { locator: "artifacts/result.txt", checkerReceiptRef: null, checkerResult: "unknown" },
    ] }] } as unknown as TaskSnapshotProjectionRow;
    const markup = renderToStaticMarkup(createElement(ExecutionEvidenceView, {
      rows: [malformed], queryStatus: "ready", onReload: vi.fn(), onReloadFromFirst: vi.fn(),
    }));

    for (const text of ["执行证据", "有通过 receipt", "无 receipt", "归档", "原生", "unknown / 未投影", "execution-level witnesses", "不等同 output receipt"]) {
      expect(markup).toContain(text);
    }
    expect(markup).toContain("review-matching · approved · 由 consent-matching 选中");
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('aria-expanded="false"');
  });

  it("offers current-query retry and a first-page invalidation path on failure", () => {
    const markup = renderToStaticMarkup(createElement(ExecutionEvidenceView, {
      rows: [], queryStatus: "error", error: new Error("bridge offline"), onReload: vi.fn(), onReloadFromFirst: vi.fn(),
    }));
    expect(markup).toContain("重试当前查询");
    expect(markup).toContain("从第一页重新加载");
    expect(markup).toContain("bridge offline");
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
