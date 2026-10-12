import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RepoCellApiContext } from "./repo-cell-api.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import type { WriteReceiptDraft } from "@harness-anything/kernel";
import { readTaskTransitionDocument } from "./transition-document-access.ts";
import { scrubProviderValue } from "./dispatch-stream.ts";
import { requireCurrentExecutionScope } from "./runtime-execution-scope.ts";

const execFileAsync = promisify(execFile);
type RunProvider = (args: readonly string[], env: NodeJS.ProcessEnv, cwd: string) => Promise<string>;
const runProvider: RunProvider = async (args, env, cwd) =>
  String(
    (await execFileAsync("gh", args, { cwd, env, timeout: 30_000, maxBuffer: 2 << 20, windowsHide: true })).stdout,
  );

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
  provider: RunProvider = runProvider,
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
  const document = readTaskTransitionDocument({ projection: context.projection, taskId, slot: "task.pr-body" }),
    env = { ...process.env, ...credential, GH_PROMPT_DISABLED: "1" },
    redact = (text: string) => String(scrubProviderValue(text.replaceAll(credential.GH_TOKEN!, "[REDACTED]")));
  try {
    const args =
      action.update === true
        ? ["pr", "edit", taskId, "--body", document.body]
        : ["pr", "create", "--head", taskId, "--title", String(task.title), "--body", document.body];
    const url = redact(await provider(args, env, context.rootDir)).trim();
    return context.withHumanSummary({
      outcome: "applied",
      opId: `task-pr:${taskId}`,
      revision: context.store.readHead()?.revision ?? 0,
      evidence: `Pull request ${action.update === true ? "updated" : "created"} for ${taskId}: ${url}`,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw context.cellCodedError("delivery_publish_failed", redact(detail).slice(0, 2048));
  }
}
