import type { TaskCompletionPrerequisiteSnapshot } from "@harness-anything/application";
import { bundledTaskDocumentPlaceholderPolicy } from "./core/task-document-placeholders.ts";

export function readTaskCompletionPrerequisiteSnapshot(): TaskCompletionPrerequisiteSnapshot {
  return {
    documentPlaceholderPolicy: bundledTaskDocumentPlaceholderPolicy()
  };
}
