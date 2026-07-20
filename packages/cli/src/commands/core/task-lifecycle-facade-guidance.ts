import type { CommandFailureReceipt, CommandReceipt } from "../../cli/receipt.ts";
import type { ParsedCommand } from "../../cli/types.ts";

export function guidedLifecycleFacadeFailure(
  failure: CommandFailureReceipt,
  completedSteps: ReadonlyArray<CommandReceipt>,
  failedStep: ParsedCommand,
  facade: "task-start" | "task-closeout"
): CommandFailureReceipt {
  const nextCommand = lifecycleFacadeNextCommand(failure, failedStep);
  const cause = failure.error?.hint ?? failure.summary;
  return {
    ...failure,
    summary: `${cause} Next: run \`${nextCommand}\`.`,
    error: failure.error ? { ...failure.error, hint: `${cause} Next: run \`${nextCommand}\`.` } : failure.error,
    next: [{ command: nextCommand }],
    details: {
      ...failure.details,
      data: {
        ...(facadeGuidanceRecord(failure.details?.data) ?? {}),
        facade: {
          schema: `${facade}-partial-failure/v1`,
          completedSteps,
          failedStep: failure
        }
      }
    }
  };
}

export function shellLifecycleToken(value: string): string {
  return /^[A-Za-z0-9_./:@{}^=-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}

function lifecycleFacadeNextCommand(failure: CommandFailureReceipt, step: ParsedCommand): string {
  if (step.action.kind === "status-set" && step.action.executionSubmission && (
    failure.error?.code === "task_lease_required" || /requires an active lease|not held by the caller/iu.test(failure.error?.hint ?? "")
  )) {
    return joinLifecycleCommand("ha", "task", "claim", step.action.taskId, "--execution", step.action.executionSubmission.executionId && "--execution-id", step.action.executionSubmission.executionId);
  }
  if (step.action.kind === "task-code-doc-reconcile" && /already exists/iu.test(failure.error?.hint ?? "")) {
    return renderLifecycleStep({ ...step, action: { ...step.action, force: true } });
  }
  if (step.action.kind === "task-complete" && step.action.ciGate === "failed") {
    return joinLifecycleCommand("ha", "task", "complete", step.action.taskId, "--ci", "passed", "--reviewer", step.action.reviewerId);
  }
  return renderLifecycleStep(step);
}

function renderLifecycleStep(command: ParsedCommand): string {
  const action = command.action;
  if (action.kind === "task-claim") {
    return joinLifecycleCommand("ha", "task", "claim", action.taskId, "--execution", action.executionId && "--execution-id", action.executionId, action.ttlMs && "--ttl-ms", action.ttlMs);
  }
  if (action.kind === "status-set" && action.status === "active") return joinLifecycleCommand("ha", "task", "transition", action.taskId, "active");
  if (action.kind === "status-set" && action.executionSubmission) {
    const submission = action.executionSubmission;
    return joinLifecycleCommand(
      "ha", "task", "transition", action.taskId, "in_review",
      submission.executionId && "--execution-id", submission.executionId,
      submission.leaseToken && "--lease-token", submission.leaseToken,
      "--completion-claim", submission.completionClaim,
      ...repeatLifecycleFlag("--deliverable", submission.deliverables),
      ...repeatLifecycleFlag("--output", submission.outputs),
      ...repeatLifecycleFlag("--verification", submission.verificationNotes),
      ...repeatLifecycleFlag("--known-gap", submission.knownGaps),
      ...repeatLifecycleFlag("--residual-risk", submission.residualRisks)
    );
  }
  if (action.kind === "task-review-execution") {
    return joinLifecycleCommand(
      "ha", "task", "review-execution", action.taskId,
      action.executionId && "--execution-id", action.executionId,
      "--verdict", action.verdict, "--findings", action.findings, "--rationale", action.rationale,
      ...repeatLifecycleFlag("--evidence-checked", action.evidenceChecked),
      action.archiveWarningsAcknowledged && "--acknowledge-archive-warnings",
      action.consentId && "--consent", action.consentId,
      action.consentUtterance && "--consent-utterance", action.consentUtterance,
      action.consentStandingPolicyDecisionId && "--consent-standing-policy", action.consentStandingPolicyDecisionId,
      action.consentAssertedRationale && "--consent-asserted", action.consentAssertedRationale,
      ...repeatLifecycleFlag("--consent-action", action.consentActions ?? [])
    );
  }
  if (action.kind === "task-code-doc-reconcile") {
    return joinLifecycleCommand("ha", "task", "code-doc", "reconcile", action.taskId, "--commit", action.sha, ...repeatLifecycleFlag("--path", action.paths), action.prRef && "--pr", action.prRef, action.force && "--force");
  }
  if (action.kind === "task-complete") return joinLifecycleCommand("ha", "task", "complete", action.taskId, "--ci", action.ciGate, "--reviewer", action.reviewerId);
  return `ha ${action.kind}`;
}

function repeatLifecycleFlag(flag: string, values: ReadonlyArray<string>): ReadonlyArray<string> {
  return values.flatMap((value) => [flag, value]);
}

function joinLifecycleCommand(...tokens: ReadonlyArray<string | number | false | undefined>): string {
  return tokens.filter((token): token is string | number => token !== false && token !== undefined).map((token) => shellLifecycleToken(String(token))).join(" ");
}

function facadeGuidanceRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
