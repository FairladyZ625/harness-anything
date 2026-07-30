import { semanticAdmissionV2 as admission } from "./semantic-authority-helpers-v2.ts";
export function assertTaskDocumentSurfaceV2(path: string): void {
  if (path === "INDEX.md" || path === "progress.md" || path === "facts.md"
    || path === "completion-evidence.json"
    || path.startsWith("executions/") || path.startsWith("reviews/")) {
    throw admission("TASK_DOCUMENT_SURFACE_OWNED_BY_TYPED_ACTION");
  }
}
