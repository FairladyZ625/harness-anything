import type { ExecutionRecord } from "../../kernel/src/index.ts";

export function assertExecutionTaskInReview(
  documents: ReadonlyArray<{ readonly path: string; readonly body: string }>,
  taskId: string
): void {
  const status = executionTaskStatus(documents, taskId);
  if (status !== "in_review") throw new Error(`task status ${status ?? "unknown"} is not in_review`);
}

export function assertExecutionTaskReviewable(
  documents: ReadonlyArray<{ readonly path: string; readonly body: string }>,
  taskId: string
): void {
  const status = executionTaskStatus(documents, taskId);
  if (status !== "active" && status !== "in_review") {
    const next = status === "planned" || status === "blocked"
      ? `run \`ha task transition ${taskId} active\`, then rerun review-execution`
      : `inspect the terminal or invalid lifecycle with \`ha task show ${taskId}\``;
    throw new Error(`task status ${status ?? "unknown"} cannot review a submitted Execution; next ${next}`);
  }
}

export function assertExecutionTaskCompletable(
  documents: ReadonlyArray<{ readonly path: string; readonly body: string }>,
  taskId: string
): void {
  const status = executionTaskStatus(documents, taskId);
  if (status !== "active" && status !== "in_review") {
    const next = status === "planned" || status === "blocked"
      ? `run \`ha task transition ${taskId} active\`, then review the submitted Execution`
      : `inspect the terminal or invalid lifecycle with \`ha task show ${taskId}\``;
    throw new Error(`task status ${status ?? "unknown"} cannot complete a submitted Execution; next ${next}`);
  }
}

function executionTaskStatus(
  documents: ReadonlyArray<{ readonly path: string; readonly body: string }>,
  taskId: string
): string | undefined {
  const body = documents.find((document) => document.path === "INDEX.md")?.body;
  if (!body) throw new Error(`task INDEX.md missing: ${taskId}`);
  return body.match(/^  status:\s*(.+)$/mu)?.[1]?.trim();
}

export function executionHasArchiveWarnings(execution: ExecutionRecord): boolean {
  return execution.session_bindings.some((binding) => {
    if (!binding || typeof binding !== "object") return false;
    const status = (binding as { readonly archive_status?: unknown }).archive_status;
    return status === "partial" || status === "unavailable";
  });
}
