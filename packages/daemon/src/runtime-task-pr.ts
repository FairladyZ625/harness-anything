import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import path from "node:path";
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

type PrBodyLintProvider = (body: string, rootDir: string) => Promise<void>;

const taskPrTitlePattern = /^(feat|fix|refactor|perf|test|docs|chore|ci)(\([A-Za-z0-9._/-]+\))?: [^\r\n]+$/u;
const taskPrTitleFormat =
  "<type>(<scope>): <summary> (type: feat|fix|refactor|perf|test|docs|chore|ci; scope is optional)";

function requireTaskPrTitle(title: unknown, required: boolean): string | undefined {
  if (title === undefined && !required) return undefined;
  if (typeof title !== "string" || !taskPrTitlePattern.test(title))
    throw new Error(`Pull request title must match ${taskPrTitleFormat}.`);
  return title;
}

/**
 * Runs the repository PR body gate — the same script CI's pr-body-lint job runs — on the task's
 * PR body before the pull request exists, so placeholder-only required sections are named here
 * instead of in review. Base and head are pinned to HEAD: this canonical-root diff is not the
 * task branch's diff, so the git-context checks (Event-Migration on accepted-sample changes) stay
 * authoritative on CI while this call judges the body itself. The gate belongs to the repository being
 * delivered, so it resolves from that repository's root; a repository without the script has no such gate.
 */
const runPrBodyLint: PrBodyLintProvider = async (body, rootDir) => {
  const script = path.join(rootDir, "tools", "check-pr-body.mjs");
  if (!existsSync(script)) return;
  await execFileAsync(process.execPath, [script, "--env", "PR_BODY"], {
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
  let title: string | undefined;
  try {
    title = requireTaskPrTitle(action.title, action.update !== true);
  } catch (error) {
    throw context.cellCodedError("invalid_field", error instanceof Error ? error.message : String(error));
  }
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
  // Worker actions must use the credential bound to their execution instance. A human principal has
  // no execution instance; let gh use the daemon/operator's own repository authentication instead.
  const credential =
    typeof instanceId === "string" ? await context.input.prepareDaemonGitEnvironment?.(instanceId, hosting.kind) : null;
  if (principal && !credential?.GH_TOKEN)
    throw context.cellCodedError(
      "runtime_credential_unavailable",
      "The dispatch instance has no configured GitHub credential. " +
        `${hostingCredentialConfigurationAdvice("github", instanceId ?? undefined)}.`,
    );
  const task = context.projection.read(taskId).snapshot.task;
  if (!task) throw context.cellCodedError("entity_not_found", `Task ${taskId} does not exist.`);
  const document = readTaskTransitionDocument({ projection: context.projection, taskId, slot: "task.pr-body" }),
    env = { ...process.env, ...credential, GH_PROMPT_DISABLED: "1" },
    redact = (text: string) =>
      String(scrubProviderValue(credential?.GH_TOKEN ? text.replaceAll(credential.GH_TOKEN, "[REDACTED]") : text));
  try {
    await prBodyLint(document.body, context.rootDir);
  } catch (error) {
    const failure = error as { readonly stderr?: string | Buffer; readonly message?: string },
      detail = String(failure.stderr ?? failure.message ?? error);
    throw context.cellCodedError(
      "content_not_ready",
      `Task ${taskId} PR body failed the repository PR body gate (placeholder-only required sections are named below); ` +
        `fix artifacts/pr-body.md, re-submit it, then retry the PR.\n${detail.slice(0, 2048)}`,
    );
  }
  try {
    const args =
      action.update === true
        ? ["pr", "edit", taskId, ...(title ? ["--title", title] : []), "--body", document.body]
        : ["pr", "create", "--head", taskId, "--title", title!, "--body", document.body];
    const url = redact(await provider(args, env, context.rootDir)).trim();
    // `next` rides the receipt the same way the lifecycle settlement receipts carry it: as a
    // draft extension outside the kernel receipt schema.
    return context.withHumanSummary({
      outcome: "applied",
      opId: `task-pr:${taskId}`,
      revision: context.store.readHead()?.revision ?? 0,
      evidence: `Pull request ${action.update === true ? "updated" : "created"} for ${taskId}: ${url}`,
      next: [
        {
          command: `gh pr checks ${url} --watch`,
          reason: "the PR's checks are the delivery authority; read and fix failures before ha task submit",
        },
      ],
    } as WriteReceiptDraft);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw context.cellCodedError("delivery_publish_failed", redact(detail).slice(0, 2048));
  }
}
