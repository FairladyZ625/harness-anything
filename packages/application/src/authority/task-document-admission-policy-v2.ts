import { semanticAdmissionV2 as admission } from "./semantic-authority-helpers-v2.ts";
import type { TaskDocumentPayloadV2 } from "./task-decision-module-command-payload-v2.ts";

export function assertTaskDocumentSurfaceV2(path: string): void {
  if (path === "INDEX.md" || path === "progress.md" || path === "facts.md"
    || path === "completion-evidence.json"
    || path.startsWith("executions/") || path.startsWith("reviews/")) {
    throw admission("TASK_DOCUMENT_SURFACE_OWNED_BY_TYPED_ACTION");
  }
}

export function assertTaskDocumentHistoryPreconditionV2(
  path: string,
  payload: TaskDocumentPayloadV2
): boolean {
  const isCodeDoc = path === "code-doc-anchors.json";
  if (isCodeDoc && !/^[a-f0-9]{64}$/u.test(payload.historyDocumentSetSha256 ?? "")) {
    throw admission("CODE_DOC_HISTORY_PRECONDITION_REQUIRED");
  }
  if (!isCodeDoc && payload.historyDocumentSetSha256 !== undefined) {
    throw admission("TASK_DOCUMENT_HISTORY_PRECONDITION_FORBIDDEN");
  }
  return isCodeDoc;
}
