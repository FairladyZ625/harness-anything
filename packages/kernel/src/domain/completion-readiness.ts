import type { TaskLifecycleSnapshot } from "./task-lifecycle.contract.ts";
import { closeoutReadiness } from "./closeout-readiness.ts";

export type CompletionBlockerCode = "not_in_review" | "closeout_placeholder" | "review_missing" | "consent_missing" | "ci_missing" | "code_doc_missing" | "lease_held" | "doc_sync_required" | "gate_witness_missing";
export interface CompletionNext { readonly command: string; readonly reason: string }
export interface CompletionBlocker { readonly code: CompletionBlockerCode; readonly gate: string; readonly next: CompletionNext }
export interface CompletionReadinessContext { readonly closeout: "ready" | "placeholder" | "dirty_eligible" | "missing"; readonly closeoutPath: string; readonly eligibleDirtyPaths: readonly string[] }

export function completionBlockers(snapshot: TaskLifecycleSnapshot, executionId: string, context: CompletionReadinessContext): readonly CompletionBlocker[] {
  const task = snapshot.task, execution = snapshot.executions.find((value) => value.executionId === executionId && value.iteration === task?.iteration), one = (code: CompletionBlockerCode, gate: string, command: string, reason: string) => [{ code, gate, next: { command, reason } }] as const;
  if (!task || task.status !== "in_review" || task.currentNode !== "review" || execution?.state !== "submitted" || !execution.submission) return one("not_in_review", "lifecycle", task?.status === "active" ? `ha task submit ${task.taskId} --execution-id ${executionId} --from-file <submission.json>` : `ha task start ${task?.taskId ?? "<task-id>"} --execution-id ${executionId}`, "Complete never submits or starts an execution; reach in_review first.");
  const submission = execution.submission;
  if (snapshot.lease !== null) return one("lease_held", "lease", `ha task submit ${task.taskId} --execution-id ${snapshot.lease.executionId} --from-file <submission.json>`, "Release the held execution lease through canonical submit.");
  const assessment = closeoutReadiness(snapshot);
  const review = snapshot.reviews.find((value) => value.executionId === executionId && value.verdict === "approved" && value.commitSha === submission.commitSha && value.iteration === execution.iteration);
  if (assessment.blocker === "review" || !review) return one("review_missing", "review", `ha task review-execution ${task.taskId} --execution-id ${executionId} --review-id <id> --from-file <review.json>`, "Record one independent approved Execution Review.");
  if (assessment.blocker === "consent") return one("consent_missing", "consent", `ha task review-consent ${task.taskId} --execution-id ${executionId} --review-id ${review.reviewId} --consent-id <id> --from-file <consent.json>`, "Record content-pinned owner consent for the approved Review.");
  const gate = assessment.gates.find(({ status }) => status !== "passed");
  if (gate) return gate.gateId === "code-doc-reconciliation"
    ? one("code_doc_missing", gate.gateId, `ha task code-doc reconcile ${task.taskId} --execution-id ${executionId} --commit-sha ${submission.commitSha} --iteration ${execution.iteration} --path <path>`, "Publish a typed code-doc witness for this execution cut.")
    : one(gate.gateId === "ci" ? "ci_missing" : "gate_witness_missing", gate.gateId, gate.gateId === "ci" ? `ha task complete ${task.taskId} --execution-id ${executionId} --ci passed` : `ha task complete ${task.taskId} --execution-id ${executionId}`, `Publish a passing canonical ${gate.gateId} checker witness for this execution cut.`);
  if (context.eligibleDirtyPaths.length) return one("doc_sync_required", "documents", `ha doc sync --submit${context.eligibleDirtyPaths.map((value) => ` --path ${value}`).join("")}`, "Publish eligible closeout and artifact edits through doc-sync.");
  if (context.closeout !== "ready") return one("closeout_placeholder", "closeout", `edit harness/${context.closeoutPath}`, "Replace the canonical closeout placeholder before completion.");
  return [];
}
