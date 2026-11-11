import path from "node:path";
import type { SubmissionV1 } from "@harness-anything/kernel";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import type { RepoCellBinding, Snapshot } from "./repo-cell-types.ts";
import { detectHostingProvider } from "./hosting-provider.ts";
import { publishTaskWorkerBranch } from "./runtime-task-publication.ts";
import { workerPushFailureCode } from "./runtime-worker-push.ts";
import { taskPrBodyRenderer } from "./task-pr-body-render.ts";
import { presetSnapshotReader, taskWorktreeBinding } from "./task-worktree.ts";

/** Called under the repository writer: publication of the frozen cut precedes automatic review. */
export async function publishSubmittedCut(
  cell: RepoCellOperationalContext,
  taskId: string,
  snapshot: Snapshot,
  submission: SubmissionV1,
  binding: RepoCellBinding,
): Promise<void> {
  // Edge submit already publishes its fenced cut; review placement leaves its dispatch on that node.
  if (submission.commitSha === null || (typeof binding.source === "object" && binding.source.kind === "node")) return;
  const hosting = await detectHostingProvider(cell.rootDir, undefined, true);
  if (!hosting) return;
  const worktree = taskWorktreeBinding(snapshot.task, presetSnapshotReader(cell.projection));
  if (!worktree)
    throw cell.cellCodedError("delivery_publish_failed", `Task ${taskId} has no managed task branch to publish.`);
  const instanceId = binding.executionPrincipal
      ? cell.projection.readRuntimeDispatch(binding.executionPrincipal.runtimeSessionId)?.payload.instanceId
      : undefined,
    env =
      typeof instanceId === "string"
        ? await cell.input.prepareDaemonGitEnvironment?.(instanceId, hosting.kind, cell.input.repoId)
        : undefined,
    renderBody = taskPrBodyRenderer({ rootDir: cell.rootDir, projection: cell.projection, taskId, submission }),
    publication = await publishTaskWorkerBranch({
      cwd: path.join(cell.rootDir, worktree.path),
      canonicalRoot: cell.rootDir,
      taskId,
      personId: binding.actor.principal.personId,
      submittedCommitSha: submission.commitSha,
      env: env ?? undefined,
      pullRequest: {
        hosting,
        taskTitle: snapshot.task?.title ?? taskId,
        submission,
        ...(renderBody ? { renderBody } : {}),
      },
    }),
    push = publication.push;
  if (!push.attempted || !push.ok)
    throw cell.cellCodedError(
      workerPushFailureCode(push),
      push.attempted ? push.detail : `Task branch publication refused: ${push.reason}.`,
    );
  if (publication.pullRequest?.headSha !== submission.commitSha)
    throw cell.cellCodedError(
      "delivery_publish_failed",
      `PR head ${publication.pullRequest?.headSha ?? "unavailable"} does not match the frozen delivery ${submission.commitSha}.`,
    );
}
