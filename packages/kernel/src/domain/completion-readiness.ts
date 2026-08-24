import type { TaskLifecycleSnapshot } from "./task-lifecycle.contract.ts";
import { closeoutReadiness } from "./closeout-readiness.ts";
import { approvedReviewsForCut } from "./review.ts";

export type CompletionBlockerCode =
  | "not_in_review"
  | "task_blocked"
  | "executor_missing"
  | "closeout_placeholder"
  | "review_missing"
  | "consent_missing"
  | "ci_missing"
  | "code_doc_missing"
  | "decision_lineage_missing"
  | "lease_held"
  | "doc_sync_required"
  | "gate_witness_missing";
export interface CompletionNext { readonly command: string; readonly reason: string }
export interface CompletionBlocker { readonly code: CompletionBlockerCode; readonly gate: string; readonly next: CompletionNext }
export interface CompletionReadinessContext { readonly closeout: "ready" | "placeholder" | "dirty_eligible" | "missing"; readonly closeoutPath: string; readonly eligibleDirtyPaths: readonly string[] }

export function completionBlockers(snapshot: TaskLifecycleSnapshot, executionId: string, context: CompletionReadinessContext): readonly CompletionBlocker[] {
  const task = snapshot.task, execution = snapshot.executions.find((value) => value.executionId === executionId && value.iteration === task?.iteration), one = (code: CompletionBlockerCode, gate: string, command: string, reason: string) => [{ code, gate, next: { command, reason } }] as const;
  if (!task || task.currentNode !== "review" || execution?.state !== "submitted" || !execution.submission) return one("not_in_review", "lifecycle", task?.status === "active" ? `ha task submit ${task.taskId} --execution-id ${executionId} --from-file <submission.json>` : `ha task start ${task?.taskId ?? "<task-id>"} --execution-id ${executionId}`, "Complete never submits or starts an execution; reach in_review first.");
  if (task.status === "blocked") return one(
    "task_blocked",
    "lifecycle",
    `ha task transition ${task.taskId} active`,
    "The submitted execution is at the review node, but the Task is explicitly blocked; clear that block.",
  );
  if (task.status === "active" && execution.actor.executor === null) return one(
    "executor_missing",
    "lifecycle",
    [
      `ha task declare-executor ${task.taskId}`,
      `--execution-id ${executionId}`,
      "--reason <auditable-recovery-reason>",
    ].join(" "),
    "The submitted execution is already at review; restore its omitted executor instead of restarting it.",
  );
  if (task.status !== "in_review") return one(
    "not_in_review",
    "lifecycle",
    `ha task show ${task.taskId}`,
    "The Task status does not match its review node; inspect the lifecycle record before completion.",
  );
  const submission = execution.submission;
  if (snapshot.lease !== null) return one("lease_held", "lease", `ha task submit ${task.taskId} --execution-id ${snapshot.lease.executionId} --from-file <submission.json>`, "Release the held execution lease through canonical submit.");
  const assessment = closeoutReadiness(snapshot);
  const approved = approvedReviewsForCut(snapshot.reviews, executionId, submission.commitSha, execution.iteration);
  if (assessment.blocker === "review" || !approved.length) return one("review_missing", "review", `ha task review-execution ${task.taskId} --execution-id ${executionId} --review-id <id> --from-file <review.json>`, "Record one independent approved Execution Review.");
  if (assessment.blocker === "consent") { const reviewId = approved.length === 1 ? approved[0]!.reviewId : "<review-id>"; return one("consent_missing", "consent", `ha task review-consent ${task.taskId} --execution-id ${executionId} --review-id ${reviewId} --consent-id <id>`, "Select one approved Review with content-pinned owner consent."); }
  const gate = assessment.gates.find(({ status }) => status !== "passed");
  if (gate) return gate.gateId === "code-doc-reconciliation"
    ? one("code_doc_missing", gate.gateId, `ha task code-doc reconcile ${task.taskId} --execution-id ${executionId} --commit-sha ${submission.commitSha} --iteration ${execution.iteration} --path <path>`, "Publish a typed code-doc witness for this execution cut.")
    : one(gate.gateId === "ci" ? "ci_missing" : "gate_witness_missing", gate.gateId, gate.gateId === "ci" ? `ha task complete ${task.taskId} --execution-id ${executionId} --ci passed` : `ha task complete ${task.taskId} --execution-id ${executionId}`, `Publish a passing canonical ${gate.gateId} checker witness for this execution cut.`);
  if (assessment.blocker === "lineage") return one("decision_lineage_missing", "lineage", `ha decision relate <decision-id> --anchor <claim-id> --type derives --target task/${task.taskId} --rationale <why this decision authorises the task>`, `A ${task.taskClass} task completes only with an active decision derives edge; no active edge names this task.`);
  if (context.eligibleDirtyPaths.length) return one("doc_sync_required", "documents", `ha doc sync --submit${context.eligibleDirtyPaths.map((value) => ` --path ${value}`).join("")}`, "Publish eligible closeout and artifact edits through doc-sync.");
  if (context.closeout !== "ready") return one("closeout_placeholder", "closeout", `edit harness/${context.closeoutPath}`, "Replace the canonical closeout placeholder before completion.");
  return [];
}
