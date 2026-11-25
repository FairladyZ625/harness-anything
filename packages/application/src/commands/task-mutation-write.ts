import {
  compileTaskLifecycleWrite,
  createTaskEvent,
  lifecycleDocumentFetchPaths,
  reduceTaskEvent,
  sha256Text,
  type TaskEventV1,
  type TaskLifecycleSnapshot,
} from "@harness-anything/kernel";
import type { CommandBinding } from "./command-ports.ts";
import type { TaskMutation } from "./task-mutation.ts";

type LifecycleWriteInput = Parameters<typeof compileTaskLifecycleWrite>[0];

export interface TaskMutationWriteDocument {
  readonly path: string;
  readonly body: string;
  readonly blobSha256: string;
}

/** One validated task mutation compiled into its canonical event and declared write. The host
 *  decides how a document read becomes ready (a projection read, a worktree guard) and supplies the
 *  completion context for the reduced snapshot; the event, reduction and write plan are shared. */
export function compileTaskMutationWrite(input: {
  readonly taskId: string;
  readonly packagePath: string;
  readonly snapshot: TaskLifecycleSnapshot;
  readonly mutation: TaskMutation;
  readonly binding: Pick<CommandBinding, "actor" | "source">;
  readonly opId: string;
  readonly workspaceRevision: number;
  readonly occurredAt: string;
  readonly readDocument: (path: string) => TaskMutationWriteDocument | null;
  readonly completionContext: (next: TaskLifecycleSnapshot) => LifecycleWriteInput["completionContext"];
}): ReturnType<typeof compileTaskLifecycleWrite> {
  const { mutation } = input,
    event = createTaskEvent(
      {
        eventId: `event-${sha256Text(input.opId)}`,
        workspaceRevision: input.workspaceRevision,
        opId: input.opId,
        taskId: input.taskId,
        actor: input.binding.actor,
        source: input.binding.source,
        occurredAt: input.occurredAt,
      },
      mutation.type,
      (mutation.execution
        ? {
            task: mutation.task,
            execution: mutation.execution,
            releasedLease: mutation.releasedLease,
            mutation: mutation.audit,
          }
        : {
            task: mutation.task,
            mutation: mutation.audit,
          }) as TaskEventV1["payload"],
    ),
    next = reduceTaskEvent(input.snapshot, event),
    currentDocuments = lifecycleDocumentFetchPaths(event, input.packagePath).flatMap((target) => {
      const document = input.readDocument(target);
      return document === null ? [] : [document];
    });
  return compileTaskLifecycleWrite({
    event,
    snapshot: next,
    packagePath: input.packagePath,
    currentDocuments,
    completionContext: input.completionContext(next),
  });
}
