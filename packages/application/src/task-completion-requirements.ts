import { Effect } from "effect";
import type { ArtifactStore, TaskId } from "@harness-anything/kernel";
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
  readonly documentPlaceholder: TaskLifecycleFailure | null;
  readonly codeDocReconciliation: TaskLifecycleFailure | null;
  readonly completionGate: CompletionGateResult;
  readonly completionAuthority: {
    readonly executionId?: string;
    readonly issues: ReadonlyArray<{ readonly code: string; readonly message: string; readonly nextCommand?: string }>;
  };
}): ReadonlyArray<TaskCompletionRequirementIssue> {
  const issues: TaskCompletionRequirementIssue[] = [];
  if (input.documentPlaceholder) {
    issues.push(requirementFromFailure(input.documentPlaceholder, "Replace closeout.md placeholders with Summary, Verification, and Residual Risk."));
  }
  if (input.codeDocReconciliation) {
    issues.push(requirementFromFailure(
      input.codeDocReconciliation,
      `ha task code-doc reconcile ${input.taskId} --commit <full-sha> [--path <repo-relative-path>]...`
    ));
  }
  for (const issue of input.completionAuthority.issues) {
    issues.push({
      code: issue.code,
      message: issue.message,
      ...(issue.nextCommand
        ? { nextCommand: issue.nextCommand }
        : issue.code === "execution_review_required" && input.completionAuthority.executionId
        ? { nextCommand: `ha task review-execution ${input.taskId} --execution-id ${input.completionAuthority.executionId} --verdict approved --findings <text> --rationale <text>` }
        : issue.code === "execution_submission_required"
          ? { nextCommand: `Claim and submit one Execution for ${input.taskId}, then rerun ha task complete.` }
          : issue.code === "archive_warnings_acknowledgement_required" && input.completionAuthority.executionId
            ? { nextCommand: `Review Execution ${input.completionAuthority.executionId} with --acknowledge-archive-warnings.` }
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
    || code === "execution_review_required"
    || code === "archive_warnings_acknowledgement_required"
    || code === "stale_execution_retirement_required";
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
        hint: `closeout.md is missing real Summary, Verification, and Residual Risk; replace its template placeholders before completing the task. If closeout.md is already substantive, retry the exact command once unchanged to refresh a lagging read. Actual task directory read: ${taskPackage?.rootPath ?? "unavailable"}.`
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
  return code ?? "write_rejected";
}
