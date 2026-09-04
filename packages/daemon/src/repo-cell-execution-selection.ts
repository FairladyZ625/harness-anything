import {
  approvedReviewHistoryForExecution,
  closeoutReadiness,
  currentSubmittedExecutions,
  getExecutableEntityAction,
  submissionDigest,
  taskActionUsage,
} from "../../kernel/src/index.ts";
import { cellCodedError, cellCriterionError } from "./repo-cell-errors.ts";
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

export function reviewExecutionSelection(
  action: RepoTaskAction,
  snapshot: Snapshot,
  taskId: string,
): {
  readonly executionId: string;
  readonly commitSha: string;
  readonly iteration: 0 | 1;
  readonly submissionDigest: `sha256:${string}`;
} {
  const requestedExecutionId = explicitExecutionId(action),
    submittedExecutions = currentSubmittedExecutions(snapshot);
  const executionId =
      requestedExecutionId ??
      uniqueDerivedExecutionId(
        submittedExecutions,
        "Current submitted execution",
        `Run ha task show ${taskId}; if the task is active, run ha task submit ${taskId} ` +
          "--json-input '<submission-json>'.",
        (candidate) =>
          `ha task review-execution ${taskId} --execution-id ${candidate} ` +
          "--review-id <review-id> --from-file <review.json>",
      ),
    submitted = snapshot.executions.find(
      (candidate) => candidate.executionId === executionId && candidate.iteration === snapshot.task?.iteration,
    );
  if (!submitted?.submission) throw reviewExecutionStateError(snapshot, taskId, submitted, executionId);
  return {
    executionId,
    commitSha: submitted.submission.commitSha,
    iteration: submitted.iteration,
    submissionDigest: submissionDigest(submitted.submission),
  };
}

export function assertExecutionExecutorDeclarationEligible(
  snapshot: Snapshot,
  taskId: string,
  executionId: string,
  candidates: readonly { readonly executionId: string }[],
): void {
  if (candidates.some((candidate) => candidate.executionId === executionId)) return;
  const execution = snapshot.executions.find((candidate) => candidate.executionId === executionId),
    executor = execution?.actor.executor,
    assigned = executor !== null && executor !== undefined;
  throw cellCodedError(
    "invalid_proof",
    "Executor declaration is only valid for a current submitted review execution with no executor.",
    {
      kind: "validation",
      entity: `execution ${executionId}`,
      field: "declareExecutor",
      actual:
        `status=${execution?.state ?? "missing"} node=${snapshot.task?.currentNode ?? "missing"} ` +
        `executor=${executor ? `${executor.kind}:${executor.id}` : "none"}`,
      expectation: assigned
        ? "Use declare-executor only when status=submitted node=review executor=none; this assigned execution " +
          `must continue with ha task review-execution ${taskId} --execution-id ${executionId} ` +
          "--review-id <review-id> --from-file <review.json>"
        : "Use declare-executor only when status=submitted node=review executor=none; run " +
          `ha task show ${taskId}, submit the current execution if needed, then retry the declaration`,
    },
  );
}

function reviewExecutionStateError(
  snapshot: Snapshot,
  taskId: string,
  execution: Snapshot["executions"][number] | undefined,
  requestedExecutionId?: string,
): Error {
  const executionId = requestedExecutionId ?? execution?.executionId;
  return cellCodedError(
    "invalid_transition",
    `Execution Review requires a submitted execution on the current iteration; current task status is ` +
      `${snapshot.task?.status ?? "missing"} and execution status is ${execution?.state ?? "missing"}. ` +
      `Submit ${executionId ?? "the current execution"} before review.`,
    {
      kind: "validation",
      entity: executionId ? `execution ${executionId}` : `task ${taskId}`,
      field: "status",
      actual: execution?.state ?? "missing",
      expectation: "Execution status must be submitted on the current task iteration before review",
    },
  );
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
        : approvedReviewHistoryForExecution(snapshot.reviews, execution)
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
  const contract = getExecutableEntityAction("task-complete");
  if (!contract) throw cellCodedError("invalid_store", "Task complete is missing from the Action catalog.");
  throw cellCriterionError(
    "invalid_command",
    "Task complete could not select one current closeout execution.",
    "complete",
    "closeout-readiness/closeoutReadiness",
    [taskActionUsage(contract, taskId)],
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
    `${factHoldsFlags(action.factHolds)}`,
    "",
  ].join("");
}

function factHoldsFlags(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const row = entry as Readonly<Record<string, unknown>>;
      if (typeof row.factRef !== "string" || typeof row.rationale !== "string") return [];
      const factId = row.factRef.startsWith("fact/") ? row.factRef.slice("fact/".length) : row.factRef;
      return [` --fact-holds ${factId}:${JSON.stringify(row.rationale)}`];
    })
    .join("");
}
