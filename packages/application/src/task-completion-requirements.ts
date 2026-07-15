import { Effect } from "effect";
import type { ArtifactStore, TaskId } from "../../kernel/src/index.ts";
import type { ExecutionCompletionReadiness } from "./execution-completion-service.ts";
import { isCloseoutPlaceholderMarkdown } from "./task-lifecycle-gates.ts";
import type { evaluateCompletionGate, TaskDocumentPlaceholderPolicy } from "./task-lifecycle-gates.ts";
import type { TaskLifecycleFailure } from "./task-lifecycle-orchestrator.ts";

type CompletionGateResult = ReturnType<typeof evaluateCompletionGate>;

export interface TaskCompletionRequirementIssue {
  readonly code: string;
  readonly gateCode?: string;
  readonly message: string;
  readonly nextCommand?: string;
}

export function collectCompletionRequirementIssues(input: {
  readonly taskId: string;
  readonly legacyReviewBlocker: TaskLifecycleFailure | null;
  readonly documentPlaceholder: TaskLifecycleFailure | null;
  readonly codeDocReconciliation: TaskLifecycleFailure | null;
  readonly completionGate: CompletionGateResult;
  readonly executionReadiness: ExecutionCompletionReadiness;
}): ReadonlyArray<TaskCompletionRequirementIssue> {
  const issues: TaskCompletionRequirementIssue[] = [];
  if (input.legacyReviewBlocker) {
    issues.push(requirementFromFailure(input.legacyReviewBlocker, "Repair review.md, then rerun ha task complete."));
  }
  if (input.documentPlaceholder) {
    issues.push(requirementFromFailure(input.documentPlaceholder, "Replace closeout.md placeholders with Summary, Verification, and Residual Risk."));
  }
  if (input.codeDocReconciliation) {
    issues.push(requirementFromFailure(
      input.codeDocReconciliation,
      `ha task code-doc reconcile ${input.taskId} --commit <full-sha> [--path <repo-relative-path>]...`
    ));
  }
  for (const issue of input.completionGate.issues) {
    if (issue.code === "closeout_not_ready" && input.documentPlaceholder) continue;
    issues.push({
      code: issue.code,
      message: issue.message,
      ...(issue.code === "missing_ci_gate" || issue.code === "ci_not_passed"
        ? { nextCommand: `ha task complete ${input.taskId} --ci passed` }
        : issue.code === "closeout_not_ready"
          ? { nextCommand: "Complete closeout.md and let the projection reach ready, then rerun ha task complete." }
          : {})
    });
  }
  for (const issue of input.executionReadiness.issues) {
    issues.push({
      code: issue.code,
      message: issue.message,
      ...(issue.code === "execution_review_required" && input.executionReadiness.executionId
        ? { nextCommand: `ha task review-execution ${input.taskId} --execution-id ${input.executionReadiness.executionId} --verdict approved --findings <text> --rationale <text>` }
        : issue.code === "execution_submission_required"
          ? { nextCommand: `Claim and submit one Execution for ${input.taskId}, then rerun ha task complete.` }
          : issue.code === "archive_warnings_acknowledgement_required" && input.executionReadiness.executionId
            ? { nextCommand: `Review Execution ${input.executionReadiness.executionId} with --acknowledge-archive-warnings.` }
            : {})
    });
  }
  return issues;
}

export function completionRequirementsFailure(
  taskId: string,
  issues: ReadonlyArray<TaskCompletionRequirementIssue>,
  completionGate: CompletionGateResult
): TaskLifecycleFailure {
  return {
    ok: false,
    taskId,
    completionGate,
    issues,
    error: {
      code: completionRequirementErrorCode(issues[0]),
      hint: `Task completion has ${issues.length} unmet requirement${issues.length === 1 ? "" : "s"}: ${issues.map(renderCompletionRequirement).join(" | ")}`
    }
  };
}

export function isExecutionCompletionRequirement(code: string): boolean {
  return code === "execution_submission_required"
    || code === "execution_task_not_in_review"
    || code === "execution_actor_cannot_complete"
    || code === "execution_review_required"
    || code === "archive_warnings_acknowledgement_required";
}

export function validateCompletionDocumentPlaceholders(
  artifactStore: Pick<ArtifactStore, "readTaskPackage">,
  taskId: string,
  policy: TaskDocumentPlaceholderPolicy | undefined
): Effect.Effect<TaskLifecycleFailure | null> {
  return Effect.gen(function* () {
    const taskPackage = policy
      ? yield* artifactStore.readTaskPackage(taskId as TaskId).pipe(Effect.catchAll(() => Effect.succeed(null)))
      : null;
    const closeout = taskPackage?.documents.find((document) => document.path === "closeout.md")?.body ?? null;
    if (!policy || closeout === null || !isCloseoutPlaceholderMarkdown(closeout, policy.closeoutPlaceholderFingerprints)) return null;
    return {
      ok: false,
      taskId,
      error: {
        code: "closeout_placeholder",
        hint: `closeout.md is missing real Summary, Verification, and Residual Risk; replace its template placeholders before completing the task. Actual task directory read: ${taskPackage?.rootPath ?? "unavailable"}.`
      }
    };
  });
}

function requirementFromFailure(failure: TaskLifecycleFailure, nextCommand: string): TaskCompletionRequirementIssue {
  const detailedIssues = (failure.issues ?? []).flatMap((issue) => {
    if (!issue || typeof issue !== "object" || Array.isArray(issue)) return [];
    const code = (issue as { readonly code?: unknown }).code;
    const message = (issue as { readonly message?: unknown }).message;
    return typeof code === "string" && typeof message === "string" ? [{ code, message }] : [];
  });
  const detail = detailedIssues[0];
  return {
    code: detail?.code ?? failure.error.code,
    ...(detail && detail.code !== failure.error.code ? { gateCode: failure.error.code } : {}),
    message: detailedIssues.length > 0 ? detailedIssues.map((issue) => issue.message).join(" ") : failure.error.hint,
    nextCommand
  };
}

function renderCompletionRequirement(issue: TaskCompletionRequirementIssue): string {
  const label = issue.gateCode && issue.gateCode !== issue.code ? `${issue.gateCode}:${issue.code}` : issue.code;
  return `[${label}] ${issue.message}${issue.nextCommand ? ` Next: ${issue.nextCommand}` : ""}`;
}

function completionRequirementErrorCode(issue: TaskCompletionRequirementIssue | undefined): string {
  const code = issue?.gateCode ?? issue?.code;
  if (code === "execution_actor_cannot_complete" || code === "execution_review_required" || code === "archive_warnings_acknowledgement_required") {
    return "write_rejected";
  }
  if (code === "execution_submission_required" || code === "execution_task_not_in_review") {
    return "execution_completion_required";
  }
  return code ?? "completion_gate_failed";
}
