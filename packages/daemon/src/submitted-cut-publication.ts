import { inWorktreeTurn } from "./task-worktree.ts";
import type { SubmissionV1 } from "@harness-anything/kernel";
import { detectHostingProvider } from "./hosting-provider.ts";
import { publishTaskPullRequest, publishTaskWorkerBranch } from "./runtime-task-publication.ts";
import { workerPushFailureCode } from "./runtime-worker-push.ts";
import { cellCodedError } from "./repo-cell-errors.ts";
import { runtimeErrorCode } from "./runtime-spawn-errors.ts";
import { scrubProviderValue } from "./dispatch-stream.ts";

/** Local submit and node review admission share this publication barrier for the frozen cut. */
export async function publishSubmittedCut(input: {
  readonly rootDir: string;
  readonly repoId: string;
  readonly taskId: string;
  readonly taskTitle: string;
  readonly submission: SubmissionV1;
  /** Local submits require a worktree; omitted only after the node's holder/CAS publication. */
  readonly workerRoot?: string | null;
  readonly personId?: string;
  readonly instanceId?: string;
  readonly prepareDaemonGitEnvironment?: (
    instanceId: string,
    provider: "github" | "gitlab",
    repoId: string,
  ) => Promise<NodeJS.ProcessEnv | null>;
  readonly renderBody?: (body: string | undefined) => string;
  /** Canonical submission fence, checked after preparation within the local publication turn. */
  readonly isCurrentCut?: () => boolean;
}): Promise<boolean> {
  const commitSha = input.submission.commitSha;
  if (commitSha === null) return true;
  const hosting = await detectHostingProvider(input.rootDir, undefined, true);
  if (!hosting) return true;
  if (input.workerRoot === null)
    throw cellCodedError("delivery_publish_failed", `Task ${input.taskId} has no managed task branch to publish.`);
  const env = input.instanceId
      ? await input.prepareDaemonGitEnvironment?.(input.instanceId, hosting.kind, input.repoId)
      : undefined,
    pullRequest = {
      hosting,
      taskTitle: input.taskTitle,
      submission: input.submission,
      ...(input.renderBody ? { renderBody: input.renderBody } : {}),
    };
  let published: { readonly headSha: string | null } | undefined;
  try {
    if (input.workerRoot) {
      const publication = await publishTaskWorkerBranch({
          cwd: input.workerRoot,
          canonicalRoot: input.rootDir,
          taskId: input.taskId,
          personId: input.personId,
          submittedCommitSha: commitSha,
          env: env ?? undefined,
          pullRequest,
          isCurrentCut: input.isCurrentCut,
        }),
        push = publication.push;
      if (!push.attempted || !push.ok)
        throw cellCodedError(
          workerPushFailureCode(push),
          push.attempted ? push.detail : `Task branch publication refused: ${push.reason}.`,
        );
      published = publication.pullRequest;
    } else
      published = await inWorktreeTurn(input.rootDir, () =>
        publishTaskPullRequest(input.taskId, pullRequest, env ?? undefined),
      );
  } catch (error) {
    if (runtimeErrorCode(error) === "execution_scope_mismatch") return false;
    if (runtimeErrorCode(error)) throw error;
    const detail = String(scrubProviderValue(error instanceof Error ? error.message : String(error))).slice(0, 512);
    throw cellCodedError("delivery_publish_failed", `PR publication failed: ${detail}`);
  }
  if (published?.headSha !== commitSha)
    throw cellCodedError(
      "delivery_publish_failed",
      `PR head ${published?.headSha ?? "unavailable"} does not match the frozen delivery ${commitSha}.`,
    );
  return true;
}
