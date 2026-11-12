import path from "node:path";
import { currentSubmittedExecutions, type WriteReceiptDraft } from "@harness-anything/kernel";
import { artifactImportSourceResolution, prepareArtifactEntityImportSource } from "./artifact-entity-action.ts";
import type { RepoCellApiContext } from "./repo-cell-api.ts";
import { taskWorktreeInput } from "./repo-cell-action-dispatch.ts";
import { startExecutionId } from "./repo-cell-command.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { resolveStackedTaskBaseline } from "./stacked-task-start.ts";
import { prepareTaskStartWorktree, presetSnapshotReader, taskWorktreeBinding } from "./task-worktree.ts";
import { workerPushFailureCode } from "./runtime-worker-push.ts";
import { requireCurrentExecutionScope } from "./runtime-execution-scope.ts";
import { publishTaskWorkerBranch } from "./runtime-task-publication.ts";
import { taskPrBodyRenderer } from "./task-pr-body-render.ts";
import { detectHostingProvider } from "./hosting-provider.ts";

type QueuedPublication = ((
  action: RepoTaskAction,
  binding: RepoCellBinding,
) => WriteReceiptDraft | Promise<WriteReceiptDraft>) & {
  /**
   * Appends what was read as its own durable writes before the action executes, so the action's
   * receipt never claims them: a rejected action stays rejected even though its reads were recorded.
   */
  readonly ingest?: (binding: RepoCellBinding) => void;
};

// A URL artifact source, GitHub, or a task worktree's setup install can stall without bound, and every
// other write to the repository would wait behind it in the write queue. These finish first; only the
// returned publication of what they produced runs inside the queue.
export function readBeforeWriteQueue(
  context: RepoCellApiContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): Promise<QueuedPublication> | null {
  const baseline =
    action.kind === "task-start" && typeof action.taskId === "string"
      ? resolveStackedTaskBaseline(
          context.projection,
          action.taskId,
          typeof action.stackOn === "string" ? action.stackOn : undefined,
        )
      : undefined;
  // The marker must name the execution the start will commit. An implicit id is deterministic from
  // this action/binding/cut, so bind it here and carry the same explicit id into the write.
  const startAction =
    action.kind === "task-start" && typeof action.taskId === "string"
      ? (() => {
          const snapshot = context.projection.read(action.taskId as string).snapshot;
          return {
            ...action,
            executionId: startExecutionId(action, binding, context.input.repoId, snapshot.revision, snapshot),
          };
        })()
      : action;
  const started = prepareTaskStartWorktree(
    taskWorktreeInput(context),
    startAction,
    binding.source,
    baseline?.kind === "commit" ? baseline.commitSha : undefined,
  );
  if (started)
    return started.then(
      (annotate) => async (action, binding) => annotate(await context.executeAction(startAction, binding)),
    );
  if (action.kind === "entity-import" && action.mode === "snapshot")
    return prepareArtifactEntityImportSource({
      rootDir: context.rootDir,
      repositoryId: context.input.repoId,
      action,
      projection: context.projection,
    }).then(
      (sourceResolution) => (action, binding) =>
        context.executeAction({ ...action, [artifactImportSourceResolution]: sourceResolution }, binding),
    );
  if (action.kind === "task-push") {
    // Everything, including the preflight, runs inside the async body: the caller turns a rejection
    // into an `op_rejected` receipt (`failAction`), while a synchronous throw would escape `run` as a
    // raw transport error — the operator would get no receipt, no code and no next action.
    return (async () => {
      const taskId = typeof action.taskId === "string" ? action.taskId : null;
      if (taskId === null) throw context.cellCodedError("invalid_command", "Task branch push requires a task id.");
      const snapshot = context.projection.read(taskId).snapshot,
        task = snapshot.task,
        worktree = taskWorktreeBinding(task, presetSnapshotReader(context.projection));
      if (!worktree)
        throw context.cellCodedError(
          "delivery_publish_failed",
          `Task ${taskId} has no Harness-managed repository worktree branch to publish.`,
        );
      const cwd = path.join(context.rootDir, worktree.path);
      if (binding.executionPrincipal)
        requireCurrentExecutionScope({
          action,
          binding,
          projection: context.projection,
          now: context.now(),
        });
      const instanceId = binding.executionPrincipal
          ? context.projection.readRuntimeDispatch(binding.executionPrincipal.runtimeSessionId)?.payload.instanceId
          : undefined,
        hosting = await detectHostingProvider(context.rootDir, undefined, true),
        daemonGitEnvironment =
          hosting && typeof instanceId === "string"
            ? await context.input.prepareDaemonGitEnvironment?.(instanceId, hosting.kind, context.input.repoId)
            : undefined;
      const gitEnvironment = daemonGitEnvironment
        ? {
            ...daemonGitEnvironment,
            GIT_ASKPASS: path.join(context.rootDir, "tools", "git-hooks", "git-askpass"),
            HARNESS_TASK_BOUND: "1",
          }
        : undefined;
      return async (_action: RepoTaskAction, executionBinding: RepoCellBinding) => {
        const latest = context.projection.read(taskId).snapshot,
          executionId = binding.executionPrincipal?.executionId,
          executions = executionId
            ? latest.executions.filter((execution) => execution.executionId === executionId)
            : currentSubmittedExecutions(latest);
        if (executions.length > 1)
          throw context.cellCodedError(
            "ambiguous_execution",
            "Publish from the worker bound to the intended submitted execution.",
          );
        const submission = executions[0]?.submission,
          renderBody = submission
            ? await taskPrBodyRenderer({
                rootDir: context.rootDir,
                projection: context.projection,
                taskId,
                submission,
              })
            : undefined,
          publication = await publishTaskWorkerBranch({
            cwd,
            canonicalRoot: context.rootDir,
            taskId,
            personId: executionBinding.actor.principal.personId,
            ...(submission?.commitSha ? { submittedCommitSha: submission.commitSha } : {}),
            ...(gitEnvironment ? { env: gitEnvironment } : {}),
            ...(hosting && submission?.commitSha
              ? {
                  pullRequest: {
                    hosting,
                    taskTitle: latest.task?.title ?? taskId,
                    submission,
                    ...(typeof action.body === "string" ? { body: action.body } : {}),
                    ...(renderBody ? { renderBody } : {}),
                  },
                }
              : {}),
          }),
          pushed = publication.push;
        if (!pushed.attempted || !pushed.ok)
          throw context.cellCodedError(
            workerPushFailureCode(pushed),
            pushed.attempted ? pushed.detail : `Task branch push refused: ${pushed.reason}.`,
          );
        const evidence =
          `Worker branch pushed: ${pushed.branch} @ ${pushed.pushedCommit}.` +
          (publication.pullRequest
            ? ` Pull request: ${publication.pullRequest.url}.`
            : submission?.commitSha
              ? " Origin is not a supported PR host."
              : " Submit the delivery before publishing its pull request.");
        return context.withHumanSummary({
          outcome: "applied",
          opId: `task-push:${taskId}:${pushed.pushedCommit}`,
          revision: context.store.readHead()?.revision ?? 0,
          evidence,
          summary: evidence,
        } as WriteReceiptDraft);
      };
    })();
  }
  return null;
}
