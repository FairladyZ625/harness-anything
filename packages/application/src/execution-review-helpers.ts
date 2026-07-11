import type { ExecutionRecord } from "../../kernel/src/index.ts";

export function assertExecutionTaskInReview(
  documents: ReadonlyArray<{ readonly path: string; readonly body: string }>,
  taskId: string
): void {
  const body = documents.find((document) => document.path === "INDEX.md")?.body;
  if (!body) throw new Error(`task INDEX.md missing: ${taskId}`);
  const status = body.match(/^  status:\s*(.+)$/mu)?.[1]?.trim();
  if (status !== "in_review") throw new Error(`task status ${status ?? "unknown"} is not in_review`);
}

export function executionActorsShareExecutor(
  left: { readonly kind: "agent"; readonly id: string } | null,
  right: { readonly kind: "agent"; readonly id: string } | null
): boolean {
  return left !== null && right !== null && left.kind === right.kind && left.id === right.id;
}

export function executionHasArchiveWarnings(execution: ExecutionRecord): boolean {
  return execution.session_bindings.some((binding) => {
    if (!binding || typeof binding !== "object") return false;
    const status = (binding as { readonly archive_status?: unknown }).archive_status;
    return status === "partial" || status === "unavailable";
  });
}
