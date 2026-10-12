import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { RepoCellApiContext } from "./repo-cell-api.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import type { WriteReceiptDraft } from "@harness-anything/kernel";
import { requireCurrentExecutionScope } from "./runtime-execution-scope.ts";

const execFileAsync = promisify(execFile);

/** Create the task PR with the dispatch credential; merge remains a separate owner action. */
export async function createTaskPullRequest(
  context: Pick<
    RepoCellApiContext,
    "rootDir" | "projection" | "now" | "cellCodedError" | "store" | "withHumanSummary"
  > & {
    readonly input: {
      readonly prepareWorkerGitEnvironment?: (instanceId: string) => Promise<NodeJS.ProcessEnv | null>;
    };
  },
  action: RepoTaskAction,
  binding: RepoCellBinding,
): Promise<WriteReceiptDraft> {
  const taskId = typeof action.taskId === "string" ? action.taskId : null;
  if (!taskId) throw context.cellCodedError("invalid_command", "Task PR creation requires a task id.");
  requireCurrentExecutionScope({ action, binding, projection: context.projection, now: context.now() });
  const principal = binding.executionPrincipal;
  const instanceId = principal
    ? context.projection.readRuntimeDispatch(principal.runtimeSessionId)?.payload.instanceId
    : undefined;
  const credential =
    typeof instanceId === "string" ? await context.input.prepareWorkerGitEnvironment?.(instanceId) : null;
  if (!credential?.GH_TOKEN)
    throw context.cellCodedError(
      "runtime_credential_unavailable",
      "The dispatch instance has no configured GitHub credential.",
    );
  const task = context.projection.read(taskId).snapshot.task;
  if (!task) throw context.cellCodedError("entity_not_found", `Task ${taskId} does not exist.`);
  const packagePath = context.projection.read(taskId).packagePath,
    bodyPath = path.join(context.rootDir, String(packagePath), "artifacts", "pr-body.md");
  try {
    await access(bodyPath);
  } catch {
    throw context.cellCodedError("document_invalid", `Task PR body is missing: ${bodyPath}`);
  }
  const env = { ...process.env, ...credential, GH_PROMPT_DISABLED: "1" };
  try {
    const result = await execFileAsync(
      "gh",
      ["pr", "create", "--head", taskId, "--title", String(task.title), "--body-file", bodyPath],
      { cwd: context.rootDir, env, timeout: 30_000, maxBuffer: 2 << 20, windowsHide: true },
    );
    const url = String(result.stdout).trim();
    return context.withHumanSummary({
      outcome: "applied",
      opId: `task-pr:${taskId}`,
      revision: context.store.readHead()?.revision ?? 0,
      evidence: `Pull request created for ${taskId}: ${url}`,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw context.cellCodedError("delivery_publish_failed", detail.slice(0, 2048));
  }
}
