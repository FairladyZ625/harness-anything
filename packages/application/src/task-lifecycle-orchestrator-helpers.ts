import { Effect } from "effect";
import type { ArtifactStore, DomainStatus, TaskId } from "@harness-anything/kernel";
import type { TaskLifecycleFailure } from "./task-lifecycle-orchestrator.ts";

export function taskFailure(taskId: string, code: string, hint: string): TaskLifecycleFailure {
  return { ok: false, taskId, error: { code, hint } };
}

export function terminalStatusFailure(taskId: string, status: DomainStatus): TaskLifecycleFailure {
  return taskFailure(
    taskId,
    "terminal_status_requires_task_complete",
    status === "done"
      ? "Use task-complete after review, CI, and closeout gates pass."
      : "Terminal cancellation requires an audited recovery path."
  );
}

export function readTaskDocument(
  artifactStore: Pick<ArtifactStore, "readTaskPackage">,
  taskId: string,
  documentPath: string
): Effect.Effect<string | null> {
  return artifactStore.readTaskPackage(taskId as TaskId).pipe(
    Effect.map((taskPackage) => taskPackage.documents.find((document) => document.path === documentPath)?.body ?? null),
    Effect.catchAll(() => Effect.succeed(null))
  );
}
