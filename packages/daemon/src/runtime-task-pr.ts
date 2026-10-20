import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as defaultSleep } from "node:timers/promises";
import type { RepoCellApiContext } from "./repo-cell-api.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { consumeKnownError, type WriteReceiptDraft } from "@harness-anything/kernel";
import { readTaskTransitionDocument } from "./transition-document-access.ts";
import { workspaceText } from "./repo-cell-packets.ts";
import { scrubProviderValue } from "./dispatch-stream.ts";
import { requireCurrentExecutionScope } from "./runtime-execution-scope.ts";
import {
  detectHostingProvider,
  hostingCredentialConfigurationAdvice,
  readHostingChecks,
  type HostingCheck,
  type HostingChecksQuery,
  type HostingChecksSnapshot,
  type HostingProvider,
} from "./hosting-provider.ts";

const execFileAsync = promisify(execFile);
type RunProvider = (args: readonly string[], env: NodeJS.ProcessEnv, cwd: string) => Promise<string>;
const runProvider: RunProvider = async (args, env, cwd) =>
  String(
    (await execFileAsync("gh", args, { cwd, env, timeout: 30_000, maxBuffer: 2 << 20, windowsHide: true })).stdout,
  );

const taskPrTitlePattern = /^(feat|fix|refactor|perf|test|docs|chore|ci)(\([A-Za-z0-9._/-]+\))?: [^\r\n]+$/u;
const taskPrTitleFormat =
  "<type>(<scope>): <summary> (type: feat|fix|refactor|perf|test|docs|chore|ci; scope is optional)";

/** The one CI-wait cadence: the daemon polls at this fixed interval and reports nothing until the
 * checks settle or the budget expires, so a waiting worker's context stays silent (dec_66CE6F92). */
export const waitCiPollIntervalMs = 15_000;
export const waitCiDefaultTimeoutMinutes = 60;

type ChecksReader = (provider: HostingProvider, query: HostingChecksQuery) => Promise<HostingChecksSnapshot>;

/** Injectable seams of the wait loop; every default is the production behavior. The injectable seam
 * is `waitCiDelay` because the durable-authorization gate resolves calls by bare function name
 * across the daemon, and a generic `delay` grafted unrelated same-named functions onto this path
 * and broke its disconnect audits. The awaited local helper stays named `sleep`: that is a wait
 * alias the poll-spin gate recognizes (so the loop must keep its exact allowlist entry), and no
 * daemon function is named `sleep`, so the authorization gate has nothing same-named to graft. */
export type WaitCiDeps = {
  /** Defaults to detecting the provider from the repository root. */
  readonly hosting?: HostingProvider;
  /** Defaults to the hosting-provider port's readHostingChecks. */
  readonly readChecks?: ChecksReader;
  /** Defaults to a real timer; tests advance a fake clock instead of sleeping. */
  readonly waitCiDelay?: (ms: number) => Promise<void>;
  readonly nowMs?: () => number;
};

type WaitCiContext = Pick<RepoCellApiContext, "rootDir" | "projection" | "now" | "cellCodedError" | "store"> & {
  readonly input: {
    readonly prepareDaemonGitEnvironment?: (
      instanceId: string,
      provider: "github" | "gitlab",
    ) => Promise<NodeJS.ProcessEnv | null>;
  };
};

/**
 * Blocks until the open pull request (GitHub) or merge request (GitLab) of the task branch has a
 * verdict on its current head: green, failed, or the wait budget expiring. A head whose checks are
 * not registered yet (an empty snapshot) is not a verdict — it waits under the same budget, and the
 * expiry names the missing registration. The single implementation
 * of CI waiting — interval and default timeout are constants, no settings. Terminal answers come
 * back as one receipt; intermediate states never leave the loop. Exit codes distinguish the three
 * results: green applies (exit 0), a red verdict is `ci_checks_failed` (exit 1), a budget expiry is
 * `ci_wait_timeout` (exit 2).
 */
export async function waitTaskPullRequestChecks(
  context: WaitCiContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
  deps: WaitCiDeps = {},
): Promise<WriteReceiptDraft> {
  const taskId = typeof action.taskId === "string" ? action.taskId : null;
  if (!taskId) throw context.cellCodedError("invalid_command", "Waiting for task PR checks requires a task id.");
  requireCurrentExecutionScope({ action, binding, projection: context.projection, now: context.now() });
  const hosting = deps.hosting ?? (await detectHostingProvider(context.rootDir)),
    principal = binding.executionPrincipal,
    instanceId = principal
      ? context.projection.readRuntimeDispatch(principal.runtimeSessionId)?.payload.instanceId
      : undefined,
    credential =
      typeof instanceId === "string"
        ? await context.input.prepareDaemonGitEnvironment?.(instanceId, hosting.kind)
        : null;
  if (principal && !credential)
    throw context.cellCodedError(
      "runtime_credential_unavailable",
      `The dispatch instance has no configured ${hosting.kind} credential. ` +
        `${hostingCredentialConfigurationAdvice(hosting.kind, instanceId ?? undefined)}.`,
    );
  const secrets = [credential?.GH_TOKEN, credential?.GITLAB_TOKEN].filter(
      (value): value is string => typeof value === "string",
    ),
    redact = (text: string) => secrets.reduce((scrubbed, secret) => scrubbed.replaceAll(secret, "[REDACTED]"), text),
    readChecks = deps.readChecks ?? readHostingChecks,
    sleep = deps.waitCiDelay ?? defaultSleep,
    nowMs = deps.nowMs ?? (() => Date.now()),
    timeoutMinutes =
      typeof action.timeoutMinutes === "number" &&
      Number.isSafeInteger(action.timeoutMinutes) &&
      action.timeoutMinutes > 0
        ? action.timeoutMinutes
        : waitCiDefaultTimeoutMinutes,
    deadline = nowMs() + timeoutMinutes * 60_000,
    query: HostingChecksQuery = { branch: taskId, env: { ...process.env, ...credential }, cwd: context.rootDir };
  let snapshot: HostingChecksSnapshot | null = null,
    lastReadError: string | null;
  for (;;) {
    try {
      snapshot = await readChecks(hosting, query);
      lastReadError = null;
    } catch (error) {
      consumeKnownError(error);
      const failure = error instanceof Error ? error : new Error(String(error)),
        code = (failure as Error & { code?: string }).code;
      // Before the first read there is no state to hold on to, and a vanished pull request is a
      // verdict about the delivery, not weather: both surface instead of riding out the budget.
      if (snapshot === null || code === "ci_pull_request_missing")
        throw Object.assign(new Error(redact(failure.message)), { code });
      lastReadError = failure.message;
    }
    const checks = snapshot!.checks,
      pending = checks.filter((check) => check.state === "pending");
    // An empty check list is "not registered yet", not a verdict: GitHub takes seconds to
    // register check runs after PR creation, and a GitLab MR without a head pipeline folds to the
    // same empty list. It waits like any pending state; the expired budget names it explicitly.
    if (checks.length > 0 && pending.length === 0) {
      const failed = checks.filter((check) => check.state === "failed");
      return failed.length > 0
        ? failedVerdict(taskId, failed, snapshot!.subjectUrl)
        : greenVerdict(taskId, checks, snapshot!.subjectUrl);
    }
    if (nowMs() >= deadline)
      return timeoutVerdict(
        taskId,
        pending.length,
        snapshot!.subjectUrl,
        timeoutMinutes,
        checks.length === 0,
        lastReadError === null ? null : redact(lastReadError),
      );
    await sleep(waitCiPollIntervalMs);
  }
}

function greenVerdict(taskId: string, checks: readonly HostingCheck[], subjectUrl: string | null): WriteReceiptDraft {
  const passed = checks.filter((check) => check.state === "passed").length,
    skipped = checks.filter((check) => check.state === "skipped").length;
  return {
    outcome: "applied",
    opId: `task-pr-wait:${taskId}`,
    evidence: subjectUrl ?? "",
    summary: `all green (${String(passed)} pass, ${String(skipped)} skipped)`,
  } as WriteReceiptDraft;
}

function failedVerdict(taskId: string, failed: readonly HostingCheck[], subjectUrl: string | null): WriteReceiptDraft {
  const names = failed
      .map((check) => check.name)
      .filter(Boolean)
      .slice(0, 3)
      .join(", "),
    url = failed.find((check) => check.url)?.url ?? subjectUrl ?? "",
    line = `failed: ${names} (${String(failed.length)} failed)${url ? ` ${url}` : ""}`;
  return {
    outcome: "op_rejected",
    opId: `task-pr-wait:${taskId}`,
    code: "ci_checks_failed",
    origin: "daemon",
    evidence: "rejection:ci_checks_failed",
    diagnostic: { kind: "failure", code: "ci_checks_failed" },
    rejectionExplanation: line,
    summary: line,
    exitCode: 1,
  } as WriteReceiptDraft;
}

function timeoutVerdict(
  taskId: string,
  pendingCount: number,
  subjectUrl: string | null,
  timeoutMinutes: number,
  noChecksRegistered: boolean,
  lastReadError: string | null,
): WriteReceiptDraft {
  const line =
    `timeout after ${String(timeoutMinutes)} minute${timeoutMinutes === 1 ? "" : "s"}: ` +
    (noChecksRegistered
      ? "no checks registered for the head"
      : `${String(pendingCount)} check${pendingCount === 1 ? "" : "s"} still pending`) +
    `${subjectUrl ? ` ${subjectUrl}` : ""}` +
    `${lastReadError ? `; last read error: ${lastReadError}` : ""}`;
  return {
    outcome: "op_rejected",
    opId: `task-pr-wait:${taskId}`,
    code: "ci_wait_timeout",
    origin: "daemon",
    evidence: "rejection:ci_wait_timeout",
    diagnostic: { kind: "failure", code: "ci_wait_timeout" },
    rejectionExplanation: line,
    summary: line,
    exitCode: 2,
  } as WriteReceiptDraft;
}

function requireTaskPrTitle(title: unknown, required: boolean): string | undefined {
  if (title === undefined && !required) return undefined;
  if (typeof title !== "string" || !taskPrTitlePattern.test(title))
    throw new Error(`Pull request title must match ${taskPrTitleFormat}.`);
  return title;
}

/** The pull request body the task PR carries: the worker's `--body-file` when provided, else the
 * task's closeout document — the framework's one delivery statement. How a repository's PR body
 * should read is that repository's own convention; this channel passes it through verbatim
 * (dec_BB2BCE9F CH1/CH2). */
function taskPrBody(
  context: Pick<RepoCellApiContext, "rootDir" | "projection">,
  action: RepoTaskAction,
  taskId: string,
) {
  if (typeof action.bodyFile === "string") return workspaceText(context.rootDir, action.bodyFile, "bodyFile");
  return readTaskTransitionDocument({ projection: context.projection, taskId, slot: "task.closeout" }).body;
}

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
  const body = taskPrBody(context, action, taskId),
    env = { ...process.env, ...credential, GH_PROMPT_DISABLED: "1" },
    redact = (text: string) =>
      String(scrubProviderValue(credential?.GH_TOKEN ? text.replaceAll(credential.GH_TOKEN, "[REDACTED]") : text));
  try {
    const args =
      action.update === true
        ? ["pr", "edit", taskId, ...(title ? ["--title", title] : []), "--body", body]
        : ["pr", "create", "--head", taskId, "--title", title!, "--body", body];
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
          command: `ha task pr ${taskId} --wait-ci`,
          reason: "the single quiet CI wait; it prints one line and its exit 0/1/2 says green/failed/timeout",
        },
      ],
    } as WriteReceiptDraft);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw context.cellCodedError("delivery_publish_failed", redact(detail).slice(0, 2048));
  }
}
