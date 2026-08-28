import {
  approvedReviewsForCut,
  canStartExecution,
  closeoutReadiness,
  currentExecutionCuts,
  currentSubmittedExecutions,
  type TaskLifecycleCommand,
} from "../../kernel/src/index.ts";
import { cellCodedError } from "./repo-cell-errors.ts";
import { actorHint } from "./repo-cell-proof.ts";
import { cellStringList, requiredCellText } from "./repo-cell-settlement.ts";
import type { RepoTaskAction, Snapshot } from "./repo-cell-types.ts";

export function explicitExecutionId(action: RepoTaskAction): string | undefined {
  return action.executionId === undefined ? undefined : requiredCellText(action.executionId, "executionId");
}

export function uniqueDerivedExecutionId(
  candidates: readonly { readonly executionId: string }[],
  label: string,
  zeroNext: string,
  commandFor: (executionId: string) => string,
): string {
  if (candidates.length === 1) return candidates[0]!.executionId;
  return rejectExecutionSelection(candidates, label, zeroNext, commandFor);
}

export function rejectExecutionSelection(
  candidates: readonly { readonly executionId: string }[],
  label: string,
  zeroNext: string,
  commandFor: (executionId: string) => string,
): never {
  const ids = candidates.map((value) => value.executionId);
  throw cellCodedError(
    "invalid_command",
    [
      "",
      `${label}`,
      " candidates: ",
      `${ids.length ? ids.join(", ") : "none"}`,
      ". ",
      `${ids.length ? `Choose one explicitly: ${ids.map(commandFor).join(" or ")}.` : zeroNext}`,
      "",
    ].join(""),
  );
}

export function reviewConsentSelection(
  action: RepoTaskAction,
  snapshot: Snapshot,
  taskId: string,
  consentId: string,
): { readonly executionId: string; readonly reviewId: string } {
  const executionId = explicitExecutionId(action),
    reviewId = action.reviewId === undefined ? undefined : requiredCellText(action.reviewId, "reviewId");
  if (executionId !== undefined && reviewId !== undefined) return { executionId, reviewId };
  const executions = currentSubmittedExecutions(snapshot).filter(
      (value) => executionId === undefined || value.executionId === executionId,
    ),
    candidates = executions.flatMap((execution) =>
      execution.submission === null
        ? []
        : approvedReviewsForCut(
            snapshot.reviews,
            execution.executionId,
            execution.submission.commitSha,
            execution.iteration,
          )
            .filter((review) => reviewId === undefined || review.reviewId === reviewId)
            .map((review) => ({
              executionId: execution.executionId,
              reviewId: review.reviewId,
            })),
    );
  if (candidates.length === 1) return candidates[0]!;
  const names = candidates.map((value) => `${value.executionId}/${value.reviewId}`),
    packet = typeof action.fromFile === "string" ? ` --from-file ${action.fromFile}` : "",
    commands = candidates.map((value) =>
      [
        "ha task review-consent ",
        `${taskId}`,
        " --execution-id ",
        `${value.executionId}`,
        " --review-id ",
        `${value.reviewId}`,
        " --consent-id ",
        `${consentId}`,
        "",
        `${packet}`,
        "",
      ].join(""),
    ),
    next = currentSubmittedExecutions(snapshot).length
      ? [
          "Run ha task review-execution ",
          `${taskId}`,
          " --review-id <review-id> --from-file <review.json>, then retry ha task ",
          "review-consent ",
          `${taskId}`,
          " --consent-id ",
          `${consentId}`,
          ".",
        ].join("")
      : `Run ha task show ${taskId}; submit the current execution before recording Review consent.`;
  throw cellCodedError(
    "invalid_command",
    [
      "Approved Review candidates: ",
      `${names.length ? names.join(", ") : "none"}`,
      ". ",
      `${commands.length ? `Choose one explicitly: ${commands.join(" or ")}.` : next}`,
      "",
    ].join(""),
  );
}

export function completeExecutionId(action: RepoTaskAction, snapshot: Snapshot, taskId: string): string {
  const supplied = explicitExecutionId(action);
  if (supplied !== undefined) return supplied;
  const assessed = closeoutReadiness(snapshot);
  if (assessed.executionId !== undefined) return assessed.executionId;
  const suffix = [
    "",
    `${action.ci === "passed" ? " --ci passed" : ""}`,
    "",
    `${cellStringList(action.paths)
      .map((value) => ` --path ${value}`)
      .join("")}`,
    "",
  ].join("");
  return rejectExecutionSelection(
    currentExecutionCuts(snapshot),
    "Closeout execution",
    [
      "Run ha task show ",
      `${taskId}`,
      "; reach one submitted current-iteration execution before retrying ha ",
      "task complete ",
      `${taskId}`,
      "",
      `${suffix}`,
      ".",
    ].join(""),
    (candidate) => `ha task complete ${taskId} --execution-id ${candidate}${suffix}`,
  );
}

export function completeRetryCommand(taskId: string, executionId: string, action: RepoTaskAction): string {
  return [
    "ha task complete ",
    `${taskId}`,
    " --execution-id ",
    `${executionId}`,
    "",
    `${action.ci === "passed" ? " --ci passed" : ""}`,
    "",
    `${cellStringList(action.paths)
      .map((value) => ` --path ${value}`)
      .join("")}`,
    "",
  ].join("");
}

export function submitLeaseRequiredMessage(
  command: Extract<TaskLifecycleCommand, { readonly type: "SubmitExecution" }>,
  snapshot: Snapshot,
): string {
  const execution = snapshot.executions.find((candidate) => candidate.executionId === command.executionId);
  if (execution?.submission)
    return [
      "Execution ",
      `${command.executionId}`,
      " is already submitted; run ha task review-execution ",
      `${command.taskId}`,
      " --execution-id ",
      `${command.executionId}`,
      " --review-id <review-id> --from-file <review.json>.",
    ].join("");
  const lease = snapshot.lease,
    submit = `ha task submit ${command.taskId} --json-input '<submission-json>'`;
  if (lease?.phase === "held")
    return [
      "Submit requires the active execution lease; the authenticated holder (",
      `${actorHint(lease.actor)}`,
      ") must run ",
      `${submit}`,
      ", or ha task release ",
      `${command.taskId}`,
      ".",
    ].join("");
  if (lease?.phase === "orphaned")
    return [
      "Submit requires the active execution lease; the lease for execution ",
      `${lease.executionId}`,
      " lapsed at ",
      `${lease.expiresAt}`,
      "; run ha task release ",
      `${command.taskId}`,
      ", then ha task start ",
      `${command.taskId}`,
      " --execution-id ",
      `${lease.executionId}`,
      ", then retry ",
      `${submit}`,
      ".",
    ].join("");
  if (lease?.phase === "reserving")
    return [
      "Submit requires the active execution lease; wait for the reservation for ",
      "execution ",
      `${lease.executionId}`,
      " to publish or lapse at ",
      `${lease.expiresAt}`,
      ", then retry ",
      `${submit}`,
      ".",
    ].join("");
  if (canStartExecution(snapshot, command.executionId))
    return [
      "Submit requires the active execution lease; run ha task start ",
      `${command.taskId}`,
      " --execution-id ",
      `${command.executionId}`,
      ", then retry ",
      `${submit}`,
      ".",
    ].join("");
  return [
    "Submit requires the active execution lease; run ha task show ",
    `${command.taskId}`,
    ", then follow the next lifecycle command reported for execution ",
    `${command.executionId}`,
    ".",
  ].join("");
}
