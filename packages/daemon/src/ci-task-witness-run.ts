// Which CI run witnesses a task delivery: the frozen contract names the delivery, and the run
// must be on the task branch and cover that commit.
import { isNativeCommitSha, type FrozenGateRequirement, type TaskProjection } from "@harness-anything/kernel";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import { ciWitnessCommit, strandedDelivery } from "./repo-cell-ci-evidence.ts";
import type { CiRunListEntry, CiWorkflowRun, RunGh } from "./ci-observation-provider.ts";
import type { CiObservationFetch } from "./ci-observation-actions.ts";

type GithubActionsOptions = Extract<
  FrozenGateRequirement["witness"],
  { readonly kind: "github-actions" }
>["adapterOptions"];

export type TaskWitness = {
  readonly taskId: string;
  readonly delivery: string;
  readonly options: GithubActionsOptions;
  readonly instanceId?: string;
};
export function taskWitnessContract(
  cell: {
    readonly rootDir: string;
    readonly cellCodedError: RepoCellOperationalContext["cellCodedError"];
    readonly projection?: Pick<TaskProjection, "read" | "readRuntimeDispatch">;
  },
  taskId: string,
): TaskWitness {
  const snapshot = cell.projection?.read(taskId).snapshot,
    execution = snapshot?.executions.find(
      (candidate) => candidate.iteration === snapshot.task?.iteration && candidate.submission !== null,
    ),
    submission = execution?.submission,
    delivery = submission?.commitSha;
  if (!isNativeCommitSha(delivery))
    throw cell.cellCodedError(
      "ci_witness_delivery_unresolved",
      `Task ${taskId} has no submitted execution with a delivery commit. ` +
        `next: submit the task delivery, then run ha ci observe pull --task ${taskId} to import its CI witness.`,
    );
  if (strandedDelivery(cell.rootDir, submission))
    throw cell.cellCodedError(
      "ci_witness_not_found",
      `No CI run can ever cover delivery ${delivery} of ${taskId}: the commit is gone or its changes ` +
        "landed under another commit. next: the task owner returns the cut with " +
        `ha task adjudicate ${taskId} --return --review-id <review-id> --note <reason>, then resubmits the landed commit.`,
    );
  const witness = submission!.completionContract.gates.find(
    (requirement) => requirement.witness.kind === "github-actions" || requirement.witness.kind === "gitlab-pipeline",
  )?.witness;
  if (witness?.kind !== "github-actions" && witness?.kind !== "gitlab-pipeline")
    throw cell.cellCodedError(
      "invalid_command",
      `Task ${taskId} has no hosted CI gate in its completion contract; no CI run witnesses it.`,
    );
  const executorId = (
    execution as { readonly actor?: { readonly executor?: { readonly id?: string } | null } } | undefined
  )?.actor?.executor?.id;
  const runtimeSessionId = executorId?.startsWith("runtime-session:")
    ? executorId.slice("runtime-session:".length)
    : undefined;
  const instanceId = runtimeSessionId
    ? cell.projection?.readRuntimeDispatch(runtimeSessionId)?.payload.instanceId
    : undefined;
  return {
    taskId,
    delivery: ciWitnessCommit(execution!) ?? delivery,
    options: witness.adapterOptions,
    ...(typeof instanceId === "string" ? { instanceId } : {}),
  };
}
export async function selectTaskWitnessRun(
  cell: { readonly rootDir: string; readonly cellCodedError: RepoCellOperationalContext["cellCodedError"] },
  { taskId, delivery, options }: TaskWitness,
  workflows: readonly string[],
  runGh: RunGh,
): Promise<Pick<CiWorkflowRun, "databaseId">> {
  const cwd = cell.rootDir,
    workflowPaths = new Set(workflows.map((workflow) => `.github/workflows/${workflow}.yml`)),
    heads =
      options.coverage === "exact"
        ? [delivery]
        : firstParentHistory(
            JSON.parse(
              await runGh(
                "gh",
                [
                  "api",
                  "repos/:owner/:repo/commits?sha=main&per_page=100",
                  "--jq",
                  "[.[] | {sha, parents: [.parents[].sha]}]",
                ],
                { cwd },
              ),
            ) as readonly { readonly sha: string; readonly parents: readonly string[] }[],
          );
  let pending: { readonly databaseId: number; readonly status: string } | undefined;
  for (const head of heads) {
    if (options.coverage !== "exact" && !(await coversCommit(runGh, cwd, delivery, head))) break;
    type WitnessRunEntry = Pick<CiRunListEntry, "databaseId" | "headBranch" | "event" | "status" | "conclusion"> & {
      readonly path: string;
    };
    const response = JSON.parse(
        await runGh(
          "gh",
          [
            "api",
            `repos/:owner/:repo/actions/runs?head_sha=${head}&per_page=100`,
            "--jq",
            "[.workflow_runs[] | {databaseId: .id, path, headBranch: .head_branch, event, status, conclusion}]",
          ],
          { cwd },
        ),
      ) as readonly WitnessRunEntry[] | { readonly workflow_runs: readonly WitnessRunEntry[] },
      entries: readonly WitnessRunEntry[] = Array.isArray(response)
        ? response
        : (response as { readonly workflow_runs: readonly WitnessRunEntry[] }).workflow_runs,
      runs = entries
        .filter((run) => run.headBranch === "main" && run.event === options.event && workflowPaths.has(run.path))
        .sort((left, right) => right.databaseId - left.databaseId);
    const verdict = runs.find(
      (run) => run.status === "completed" && run.conclusion !== "cancelled" && run.conclusion !== "skipped",
    );
    if (verdict) return { databaseId: verdict.databaseId };
    pending ??= runs.find((run) => run.status !== "completed");
  }
  if (pending)
    throw cell.cellCodedError(
      "ci_witness_not_found",
      `No completed main CI run covers delivery ${delivery} of ${taskId}. ` +
        `next: run ${pending.databaseId} is ${pending.status}; retry after it concludes.`,
    );
  throw cell.cellCodedError(
    "ci_witness_not_found",
    `No completed main CI run covers delivery ${delivery} of ${taskId}. ` +
      "next: no covering run exists yet; retry after the next main run completes.",
  );
}
function firstParentHistory(page: readonly { readonly sha: string; readonly parents: readonly string[] }[]): string[] {
  const parents = new Map(page.map((commit) => [commit.sha, commit.parents[0]]));
  const chain: string[] = [];
  for (let sha: string | undefined = page[0]?.sha; sha !== undefined && parents.has(sha); sha = parents.get(sha))
    chain.push(sha);
  return chain;
}
export function taskWitnessSummary({ witness, runs }: CiObservationFetch): string {
  const run = witness && runs.find((candidate) => candidate.databaseId === witness.databaseId);
  return run
    ? `${witness.taskId} CI witness: run ${run.databaseId} (${run.summary.workflowName}) concluded ` +
        `${run.summary.conclusion} on ${run.summary.headSha}, covering delivery ${witness.delivery}.\n`
    : "";
}
async function coversCommit(runGh: RunGh, cwd: string, base: string, head: string): Promise<boolean> {
  const compare = JSON.parse(
    await runGh("gh", ["api", `repos/:owner/:repo/compare/${base}...${head}`, "--jq", "{status: .status}"], { cwd }),
  ) as {
    readonly status?: string;
  };
  return compare.status === "ahead" || compare.status === "identical";
}
