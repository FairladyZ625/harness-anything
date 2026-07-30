import { Effect } from "effect";
import type { CommitCompletionService, TaskCompletionAuthorityInput } from "./task-completion-authority.ts";
import type { TaskLifecycleResult, TaskLifecycleSuccess } from "./task-lifecycle-orchestrator.ts";

export function completeTaskWithCommitEvidence(
  service: CommitCompletionService,
  input: TaskCompletionAuthorityInput & { readonly mode: "commit-anchor" },
  completionGate: NonNullable<TaskLifecycleSuccess["completionGate"]>
): Effect.Effect<TaskLifecycleResult> {
  return Effect.tryPromise({
    try: () => service.complete(input),
    catch: (error) => error
  }).pipe(Effect.match({
    onFailure: (error): TaskLifecycleResult => ({
      ok: false,
      taskId: input.taskId,
      error: {
        code: "write_rejected",
        hint: `Commit completion evidence transaction was rejected: ${error instanceof Error ? error.message : String(error)}. Run ha task show ${input.taskId}, inspect the changed task evidence, then retry the exact task complete command.`
      }
    }),
    onSuccess: (evidence): TaskLifecycleResult => ({
      ok: true,
      taskId: input.taskId,
      status: "done",
      completionEvidence: evidence,
      completionGate: { ...completionGate, evidenceMode: "commit-anchor" }
    })
  }));
}
