import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RepoCellApiContext } from "./repo-cell-api.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { requireCurrentExecutionScope } from "./runtime-execution-scope.ts";
import { scrubProviderValue } from "./dispatch-stream.ts";
import type { WriteReceiptDraft } from "@harness-anything/kernel";

const execFileAsync = promisify(execFile);
type RunProvider = (args: readonly string[], env: NodeJS.ProcessEnv, cwd: string) => Promise<string>;
const runProvider: RunProvider = async (args, env, cwd) =>
  String(
    (await execFileAsync("gh", args, { env, cwd, timeout: 30_000, maxBuffer: 8 << 20, windowsHide: true })).stdout,
  );

interface Check {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly details_url: string | null;
}
interface Run {
  readonly id: number;
  readonly workflow_id: number;
  readonly run_attempt: number;
  readonly head_sha: string;
  readonly head_branch: string;
  readonly event: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly html_url: string;
}
interface Job {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly html_url: string;
}
interface Pull {
  readonly number: number;
  readonly mergeable_state: string | null;
}

interface TaskCiReport {
  readonly schema: "task-ci/v1";
  readonly taskId: string;
  readonly branch: string;
  readonly headSha: string;
  readonly conclusion: "not_started" | "pending" | "success" | "failure";
  /** Present only when conclusion is not_started: names whether waiting can help and what to do instead. */
  readonly notStarted?: {
    readonly reason: "no_pull_request" | "pull_request_conflict" | "queued";
    readonly detail: string;
  };
  readonly checks: readonly {
    readonly name: string;
    readonly status: string;
    readonly conclusion: string | null;
    readonly url: string | null;
  }[];
  readonly runs: readonly {
    readonly id: number;
    readonly attempt: number;
    readonly event: string;
    readonly status: string;
    readonly conclusion: string | null;
    readonly url: string;
    readonly jobs: readonly {
      readonly id: number;
      readonly name: string;
      readonly status: string;
      readonly conclusion: string | null;
      readonly url: string;
      readonly failure: (ReturnType<typeof failureExcerpt> & { readonly logUrl: string }) | null;
    }[];
  }[];
}

/** Read only the authenticated dispatch's published task branch; never accept a ref or run id. */
export async function readTaskCi(
  context: {
    readonly rootDir: string;
    readonly input: RepoCellApiContext["input"];
    readonly projection: RepoCellApiContext["projection"];
    readonly now: RepoCellApiContext["now"];
    readonly cellCodedError: RepoCellApiContext["cellCodedError"];
    readonly readResult?: RepoCellApiContext["extracted"]["readResult"];
  },
  action: RepoTaskAction,
  binding: RepoCellBinding,
  provider: RunProvider = runProvider,
): Promise<WriteReceiptDraft & { readonly ci: TaskCiReport }> {
  const principal = binding.executionPrincipal;
  if (!principal)
    throw context.cellCodedError("actor_unauthorized", "Task CI requires a bound worker or reviewer dispatch.");
  requireCurrentExecutionScope({ action, binding, projection: context.projection, now: context.now() });
  const instanceId = context.projection.readRuntimeDispatch(principal.runtimeSessionId)?.payload.instanceId;
  const credential =
    typeof instanceId === "string" ? await context.input.prepareWorkerGitEnvironment?.(instanceId) : null;
  if (!credential?.GH_TOKEN)
    throw context.cellCodedError(
      "runtime_credential_unavailable",
      "The dispatch instance has no configured GitHub credential.",
    );
  const env = { ...process.env, ...credential },
    redact = (text: string) => String(scrubProviderValue(text.replaceAll(credential.GH_TOKEN!, "[REDACTED]")));
  const runCommand = async (args: readonly string[]): Promise<string> => {
    try {
      return redact(await provider(args, env, context.rootDir));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw context.cellCodedError("task_ci_read_failed", redact(detail).slice(0, 2048));
    }
  };
  const repository = (
    JSON.parse(await runCommand(["repo", "view", "--json", "nameWithOwner"])) as { nameWithOwner: string }
  ).nameWithOwner;
  const api = async <T>(endpoint: string, paginated = false): Promise<T> =>
    JSON.parse(await runCommand(["api", ...(paginated ? ["--paginate", "--slurp"] : []), endpoint])) as T;
  const prefix = `repos/${repository}/`,
    branch = principal.taskId,
    head = await api<{ readonly commit: { readonly sha: string } }>(`${prefix}branches/${encodeURIComponent(branch)}`),
    headSha = head.commit.sha;
  const [checkPages, runPages] = await Promise.all([
    api<readonly { readonly check_runs: readonly Check[] }[]>(
      `${prefix}commits/${headSha}/check-runs?per_page=100`,
      true,
    ),
    api<readonly { readonly workflow_runs: readonly Run[] }[]>(
      `${prefix}actions/runs?head_sha=${headSha}&per_page=100`,
      true,
    ),
  ]);
  // Newest run per workflow/event replaces a superseded run, including its failed jobs.
  const latest = new Map<string, Run>();
  for (const run of runPages.flatMap((page) => page.workflow_runs).sort((a, b) => b.id - a.id)) {
    if (run.head_sha !== headSha || run.head_branch !== branch || !["push", "pull_request"].includes(run.event))
      continue;
    const key = `${run.workflow_id}:${run.event}`;
    if (!latest.has(key)) latest.set(key, run);
  }
  const runs = [];
  for (const run of latest.values()) {
    const pages = await api<readonly { readonly jobs: readonly Job[] }[]>(
      `${prefix}actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
      true,
    );
    const jobs = [];
    for (const job of pages.flatMap((page) => page.jobs)) {
      let failure = null;
      if (job.conclusion === "failure") {
        const log = await runCommand([
          "run",
          "view",
          String(run.id),
          "--repo",
          repository,
          "--job",
          String(job.id),
          "--log-failed",
        ]);
        failure = { ...failureExcerpt(log), logUrl: job.html_url };
      }
      jobs.push({
        id: job.id,
        name: job.name,
        status: job.status,
        conclusion: job.conclusion,
        url: job.html_url,
        failure,
      });
    }
    runs.push({
      id: run.id,
      attempt: run.run_attempt,
      event: run.event,
      status: run.status,
      conclusion: run.conclusion,
      url: run.html_url,
      jobs,
    });
  }
  // Newest check run per name replaces a superseded one, so a re-run verdict matches the newest-run rule above.
  const latestChecks = new Map<string, Check>();
  for (const check of checkPages.flatMap((page) => page.check_runs).sort((a, b) => b.id - a.id)) {
    if (!latestChecks.has(check.name)) latestChecks.set(check.name, check);
  }
  const checks = [...latestChecks.values()].map((check) => ({
    name: check.name,
    status: check.status,
    conclusion: check.conclusion,
    url: check.details_url,
  }));
  const states = [...checks, ...runs],
    conclusion =
      states.length === 0
        ? "not_started"
        : states.some((state) => state.status !== "completed")
          ? "pending"
          : states.every((state) => ["success", "neutral", "skipped"].includes(state.conclusion ?? ""))
            ? "success"
            : "failure";
  // An empty report explains itself — the only extra API round happens on this empty path.
  const notStarted =
    conclusion !== "not_started" ? undefined : await explainNotStarted(api, prefix, repository, branch);
  const ci: TaskCiReport = {
      schema: "task-ci/v1",
      taskId: branch,
      branch,
      headSha,
      conclusion,
      ...(notStarted ? { notStarted } : {}),
      checks,
      runs,
    },
    revision = context.projection.readCut().sourceRevision;
  return {
    ...(context.readResult?.(`task-ci:${branch}:${headSha}`, ci, revision, null) ?? {
      outcome: "applied",
      opId: `task-ci:${branch}:${headSha}`,
      revision,
      evidence: JSON.stringify(ci),
    }),
    ci,
  };
}

type ApiReader = <T>(endpoint: string, paginated?: boolean) => Promise<T>;

/** Distinguish the not_started cases the worker can act on (open the PR, resolve a conflict) from
 * the one where waiting is the right move. #3557 surfaced this: a conflicting pull request read as
 * a bare not_started and the worker had nothing to act on. */
async function explainNotStarted(
  api: ApiReader,
  prefix: string,
  repository: string,
  branch: string,
): Promise<NonNullable<TaskCiReport["notStarted"]>> {
  const [owner] = repository.split("/");
  const pulls = await api<readonly Pull[]>(
    `${prefix}pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=open`,
  );
  const conflicting = pulls.find((pull) => pull.mergeable_state === "dirty");
  if (conflicting)
    return {
      reason: "pull_request_conflict",
      detail:
        `Pull request #${conflicting.number} for this branch conflicts with its base branch ` +
        "(mergeable_state dirty). Rebase onto the base and push again; no CI verdict arrives while the conflict stands.",
    };
  if (pulls.length === 0)
    return {
      reason: "no_pull_request",
      detail:
        `No open pull request for branch ${branch}; pull-request-triggered checks cannot start. ` +
        `Open one with ha task pr ${branch}.`,
    };
  return {
    reason: "queued",
    detail:
      "No checks or workflow runs are registered for this head SHA yet; GitHub may still be queuing them. " +
      `Read again after a short wait (ha task ci ${branch} --wait).`,
  };
}

/** Preserve failed test names and the assertion context, while bounding the returned diagnostic. */
export function failureExcerpt(log: string): {
  readonly tests: readonly string[];
  readonly excerpt: string;
  readonly truncated: boolean;
} {
  const lines = log.split(/\r?\n/u),
    tests = lines.filter((line) => /not ok\s+\d+|[✖×]\s|FAIL\s/u.test(line)),
    indices = new Set<number>();
  lines.forEach((line, index) => {
    if (/not ok\s+\d+|[✖×]\s|FAIL\s|AssertionError|error:|Expected|actual:|expected:|##\[error\]/u.test(line))
      for (let i = Math.max(0, index - 2); i <= Math.min(lines.length - 1, index + 12); i++) indices.add(i);
  });
  const excerpt = indices.size
    ? [...indices]
        .sort((a, b) => a - b)
        .map((i) => lines[i])
        .join("\n")
    : log;
  return {
    tests: [...new Set(tests.map((line) => line.slice(0, 512)))].slice(0, 40),
    excerpt: excerpt.slice(0, 8192),
    truncated: excerpt.length > 8192 || new Set(tests).size > 40,
  };
}
