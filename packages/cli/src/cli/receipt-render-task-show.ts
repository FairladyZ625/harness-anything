import { isRecord, nonEmptyText } from "./receipt-render-values.ts";

export function renderTaskShow(
  receipt: Record<string, unknown>,
  payload: Record<string, unknown> | null,
): string | null {
  if (!payload || !isRecord(payload.task)) return null;
  const gates = Array.isArray(payload.task.completionGateIds) ? payload.task.completionGateIds : [],
    blocker = isRecord(payload.completionBlocker) ? payload.completionBlocker : null,
    reviewDispatchFailure = isRecord(payload.task.reviewDispatchFailure) ? payload.task.reviewDispatchFailure : null,
    // The same judgment task complete rejects with: the daemon already resolves reason and action
    // once, so the read side prints that guidance instead of a bare gate code. A ready cut keeps
    // `completionNext` while the blocker is null: that is its `ha task complete` step.
    next = isRecord(payload.completionNext) ? payload.completionNext : null,
    hint = next === null ? null : nonEmptyText(next.reason),
    action = next === null ? null : nonEmptyText(next.action);
  return [
    `status: ${String(payload.task.status)}`,
    ...(reviewDispatchFailure === null
      ? []
      : [`review dispatch failed: ${String(reviewDispatchFailure.code)}; ${String(reviewDispatchFailure.message)}`]),
    `graph cursor: ${String(payload.task.currentNode)}`,
    ...executionLines(payload),
    ...(Array.isArray(payload.reworkTargets)
      ? payload.reworkTargets.flatMap((target) =>
          isRecord(target) && typeof target.executionId === "string" && typeof target.submissionDigest === "string"
            ? [`rework cut: --execution-id ${target.executionId} --submission-digest ${target.submissionDigest}`]
            : [],
        )
      : []),
    ...(isRecord(payload.task.executionArrangement)
      ? [
          `execution arrangement: ${String(payload.task.executionArrangement.id)}; ${payload.task.executionArrangement.ready === true ? "handoff complete" : "handoff pending"}; round ${String(payload.task.executionArrangement.iteration)}`,
        ]
      : []),
    ...deliveryBaselineLines(payload),
    // Optional on the write-receipt schema: legacy receipts predate the field and render no line.
    ...(typeof receipt.expectedVersion === "number"
      ? [
          `expected-version: ${String(receipt.expectedVersion)} (pass as --expected-version to assign/unassign/transition)`,
        ]
      : []),
    `completion gates: ${
      [...gates, ...(typeof blocker?.gate === "string" ? [`${blocker.gate} (${String(blocker.code)})`] : [])].join(
        ", ",
      ) || "none"
    }`,
    ...(hint === null ? [] : [`completion hint: ${hint}`]),
    ...(action === null ? [] : [`completion next: ${action}`]),
    `packageDisposition: ${String(payload.task.packageDisposition ?? "active")}`,
    ...(isRecord(payload.workspace) ? [workspaceLine(payload.workspace, payload.worktreeSetup)] : []),
    ...(typeof payload.returnBudget === "number"
      ? [`returnBudget=${String(payload.returnBudget)} (repository rework round limit)`]
      : []),
  ].join("\n");
}

/**
 * The current execution ids an owner needs for review/consent commands, so getting one never
 * requires probing a write. The daemon derives the current-iteration list; ambiguity stays
 * visible as one row per execution with its state rather than silently picking the first.
 */
function executionLines(payload: Record<string, unknown>): readonly string[] {
  if (!Array.isArray(payload.currentExecutions)) return [];
  const rows = payload.currentExecutions.flatMap((execution) =>
    isRecord(execution) && typeof execution.executionId === "string" && typeof execution.state === "string"
      ? [`${execution.executionId} (${execution.state})`]
      : [],
  );
  return [
    `execution: ${rows.length ? rows.join(", ") : "none"} (pass as --execution-id to review/review-consent/complete)`,
  ];
}

/**
 * The comparison cut each current execution froze at start. Printing the raw sha without its
 * semantics is what let a reviewer read an old baseline as a stale delivery head
 * (task_199ad30eb5cdd072cd65317919), so the value and the sentence always travel together.
 */
function deliveryBaselineLines(payload: Record<string, unknown>): readonly string[] {
  if (
    !Array.isArray(payload.executions) ||
    !Array.isArray(payload.currentExecutions) ||
    typeof payload.deliveryBaselineNote !== "string" ||
    payload.deliveryBaselineNote === ""
  )
    return [];
  const current = payload.currentExecutions.flatMap((execution) =>
    isRecord(execution) && typeof execution.executionId === "string" ? [execution.executionId] : [],
  );
  return payload.executions.flatMap((execution) => {
    if (!isRecord(execution) || typeof execution.executionId !== "string" || !current.includes(execution.executionId))
      return [];
    const baseline = isRecord(execution.deliveryBaseline) ? execution.deliveryBaseline : null,
      ref =
        baseline === null
          ? null
          : baseline.kind === "empty-tree"
            ? "empty-tree"
            : typeof baseline.commitSha === "string"
              ? baseline.commitSha
              : null;
    return ref === null ? [] : [`delivery baseline: ${ref} (${payload.deliveryBaselineNote})`];
  });
}

/** dec_8B3FCCD256CAC5B0BF3CCEDE58 CH4: one line tells where every task works. */
function workspaceLine(workspace: Record<string, unknown>, setup: unknown): string {
  if (workspace.kind !== "worktree")
    return `workspace: ${String(workspace.path)} (task package; this task does not change repository files)`;
  const declared = isRecord(setup) && Array.isArray(setup.declared) ? setup.declared.map(String) : [],
    succeeded = isRecord(setup) && Array.isArray(setup.succeeded) ? setup.succeeded.map(String) : null,
    rows =
      succeeded === null
        ? declared.length
          ? [`${declared.join("; ")} (unknown: no checkout on this node)`]
          : []
        : [
            ...declared.map((step) =>
              succeeded.includes(step) ? `${step} (done)` : `${step} (pending, runs at next start)`,
            ),
            ...succeeded.filter((step) => !declared.includes(step)).map((step) => `${step} (done)`),
          ],
    steps = rows.length ? rows.join("; ") : "none";
  return (
    `workspace: ${String(workspace.path)} (worktree on branch ${String(workspace.branch)}, ` +
    `${String(workspace.state)}; setup: ${steps}; managed by Harness, no command needed)`
  );
}
