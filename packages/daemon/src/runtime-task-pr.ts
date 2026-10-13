import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { RepoCellApiContext } from "./repo-cell-api.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import type { WriteReceiptDraft } from "@harness-anything/kernel";
import { readTaskTransitionDocument } from "./transition-document-access.ts";
import { scrubProviderValue } from "./dispatch-stream.ts";
import { requireCurrentExecutionScope } from "./runtime-execution-scope.ts";
import { detectHostingProvider, hostingCredentialConfigurationAdvice } from "./hosting-provider.ts";

const execFileAsync = promisify(execFile);
type RunProvider = (args: readonly string[], env: NodeJS.ProcessEnv, cwd: string) => Promise<string>;
const runProvider: RunProvider = async (args, env, cwd) =>
  String(
    (await execFileAsync("gh", args, { cwd, env, timeout: 30_000, maxBuffer: 2 << 20, windowsHide: true })).stdout,
  );

const prBodyLintScript = fileURLToPath(new URL("../../../tools/check-pr-body-bilingual.mjs", import.meta.url));
type PrBodyLintProvider = (body: string, rootDir: string) => Promise<void>;

/**
 * Runs the repository PR body gate — the same script CI's pr-body-lint job runs — on the task's
 * PR body before the pull request exists, so placeholder-only required sections are named here
 * instead of in review. Base and head are pinned to HEAD: this canonical-root diff is not the
 * task branch's diff, so the git-context checks (Per-Write Cost table, churn thresholds) stay
 * authoritative on CI while this call judges the body itself.
 */
const runPrBodyLint: PrBodyLintProvider = async (body, rootDir) => {
  await execFileAsync(process.execPath, [prBodyLintScript, "--env", "PR_BODY"], {
    cwd: rootDir,
    timeout: 120_000,
    maxBuffer: 2 << 20,
    windowsHide: true,
    env: { ...process.env, PR_BODY: body, PR_BASE_SHA: "HEAD", PR_HEAD_SHA: "HEAD" },
  });
};

/** Create the task PR with the dispatch credential; merge remains a separate owner action. */
export async function createTaskPullRequest(
  context: Pick<
    RepoCellApiContext,
    "rootDir" | "projection" | "now" | "cellCodedError" | "store" | "withHumanSummary"
  > & {
    readonly input: {
      readonly prepareDaemonGitEnvironment?: (
        instanceId: string,
        provider: "github" | "gitlab",
      ) => Promise<NodeJS.ProcessEnv | null>;
    };
  },
  action: RepoTaskAction,
  binding: RepoCellBinding,
  provider: RunProvider = runProvider,
  prBodyLint: PrBodyLintProvider = runPrBodyLint,
): Promise<WriteReceiptDraft> {
  const taskId = typeof action.taskId === "string" ? action.taskId : null;
  if (!taskId) throw context.cellCodedError("invalid_command", "Task PR creation requires a task id.");
  requireCurrentExecutionScope({ action, binding, projection: context.projection, now: context.now() });
  const principal = binding.executionPrincipal;
  const instanceId = principal
    ? context.projection.readRuntimeDispatch(principal.runtimeSessionId)?.payload.instanceId
    : undefined;
  const hosting =
    provider === runProvider ? await detectHostingProvider(context.rootDir) : ({ kind: "github" } as const);
  if (hosting.kind !== "github")
    throw context.cellCodedError(
      "delivery_publish_failed",
      "Task PR creation is currently supported only for GitHub repositories.",
    );
  const credential =
    typeof instanceId === "string" ? await context.input.prepareDaemonGitEnvironment?.(instanceId, hosting.kind) : null;
  if (!credential?.GH_TOKEN)
    throw context.cellCodedError(
      "runtime_credential_unavailable",
      "The dispatch instance has no configured GitHub credential. " +
        `${hostingCredentialConfigurationAdvice("github", instanceId ?? undefined)}.`,
    );
  const task = context.projection.read(taskId).snapshot.task;
  if (!task) throw context.cellCodedError("entity_not_found", `Task ${taskId} does not exist.`);
  const document = readTaskTransitionDocument({ projection: context.projection, taskId, slot: "task.pr-body" }),
    env = { ...process.env, ...credential, GH_PROMPT_DISABLED: "1" },
    redact = (text: string) => String(scrubProviderValue(text.replaceAll(credential.GH_TOKEN!, "[REDACTED]")));
  try {
    await prBodyLint(document.body, context.rootDir);
  } catch (error) {
    const failure = error as { readonly stderr?: string | Buffer; readonly message?: string },
      detail = String(failure.stderr ?? failure.message ?? error);
    throw context.cellCodedError(
      "content_not_ready",
      `Task ${taskId} PR body failed the bilingual gate (placeholder-only required sections are named below); ` +
        `fix artifacts/pr-body.md, re-submit it, then retry the PR.\n${detail.slice(0, 2048)}`,
    );
  }
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
