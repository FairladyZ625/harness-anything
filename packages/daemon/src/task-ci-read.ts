import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RepoCellApiContext } from "./repo-cell-api.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { requireCurrentExecutionScope } from "./runtime-execution-scope.ts";
import { scrubProviderValue } from "./dispatch-stream.ts";
import { consumeKnownError, type WriteReceiptDraft } from "@harness-anything/kernel";
import type { CiObservationRead, CiRunDetail } from "@harness-anything/kernel";
import { extractCiFailure } from "./ci-failure-detail.ts";
import {
  detectHostingProvider,
  hostingCredentialConfigurationAdvice,
  type HostingProvider,
} from "./hosting-provider.ts";

const execFileAsync = promisify(execFile);
type RunProvider = (args: readonly string[], env: NodeJS.ProcessEnv, cwd: string) => Promise<string>;
type CiCache = {
  repository?: string;
  readonly reports: Map<string, { readonly expiresAt: number; readonly ci: TaskCiReport }>;
  readonly inFlight: Map<string, Promise<TaskCiReport>>;
};
const ciCaches = new WeakMap<object, CiCache>();
const ciReportTtlMs = 60_000;
function taskCiCache(projection: object): CiCache {
  let cache = ciCaches.get(projection);
  if (!cache) ciCaches.set(projection, (cache = { reports: new Map(), inFlight: new Map() }));
  return cache;
}
function cachedTaskCi(cache: CiCache, branch: string, headSha: string): TaskCiReport | undefined {
  const key = `${branch}\u0000${headSha}`;
  let result: TaskCiReport | undefined;
  for (const [candidate, entry] of cache.reports) {
    if (entry.expiresAt <= Date.now() || (candidate.startsWith(`${branch}\u0000`) && candidate !== key)) {
      cache.reports.delete(candidate);
    } else if (candidate === key) result = entry.ci;
  }
  return result;
}
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

export interface TaskCiReport {
  readonly schema: "task-ci/v2";
  readonly taskId: string;
  readonly branch: string;
  readonly headSha: string;
  readonly conclusion: "not_started" | "pending" | "success" | "failure";
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
      readonly failure: TaskCiJobFailure | null;
    }[];
  }[];
}

/** Read only the authenticated dispatch's published task branch; never accept a ref or run id. */
export async function readTaskCi(
  context: {
    readonly rootDir: string;
    readonly input: RepoCellApiContext["input"];
    readonly projection: RepoCellApiContext["projection"];
    readonly store?: { readonly readContentBlob: (sha256: string) => Uint8Array | null };
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
  if (typeof context.projection.readCiRunObservations === "function" && context.store)
    return readTaskCiFromObservations(context, principal.taskId, action);
  const instanceId = context.projection.readRuntimeDispatch(principal.runtimeSessionId)?.payload.instanceId;
  let hosting: HostingProvider;
  if (provider !== runProvider) hosting = { kind: "github" } as HostingProvider;
  // Provider injection is the test seam and may use a repository-less temporary directory.
  // A configured but unknown remote still goes through strict provider detection.
  else
    hosting = (await hasOriginRemote(context.rootDir))
      ? await detectHostingProvider(context.rootDir)
      : ({ kind: "github" } as HostingProvider);
  const credential =
    typeof instanceId === "string" ? await context.input.prepareDaemonGitEnvironment?.(instanceId, hosting.kind) : null;
  const token = credential?.GH_TOKEN ?? credential?.GITLAB_TOKEN;
  if (!token)
    throw context.cellCodedError(
      "runtime_credential_unavailable",
      `The dispatch instance has no configured ${hosting.kind === "gitlab" ? "GitLab" : "GitHub"} credential. ` +
        `${hostingCredentialConfigurationAdvice(hosting.kind, typeof instanceId === "string" ? instanceId : undefined)}.`,
    );
  const env = { ...process.env, ...credential },
    redact = (text: string) => String(scrubProviderValue(text.replaceAll(token, "[REDACTED]")));
  if (hosting.kind === "gitlab") return readGitLabTaskCi(context, action, hosting, token, redact);
  const runCommand = async (args: readonly string[]): Promise<string> => {
    try {
      return redact(await provider(args, env, context.rootDir));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw context.cellCodedError("task_ci_read_failed", redact(detail).slice(0, 2048));
    }
  };
  const cache = taskCiCache(context.projection);
  const repository =
    cache.repository ??
    (JSON.parse(await runCommand(["repo", "view", "--json", "nameWithOwner"])) as { nameWithOwner: string })
      .nameWithOwner;
  cache.repository = repository;
  const api = async <T>(endpoint: string, paginated = false): Promise<T> =>
    JSON.parse(await runCommand(["api", ...(paginated ? ["--paginate", "--slurp"] : []), endpoint])) as T;
  const prefix = `repos/${repository}/`,
    branch = principal.taskId,
    head = await api<{ readonly commit: { readonly sha: string } }>(`${prefix}branches/${encodeURIComponent(branch)}`),
    headSha = head.commit.sha;
  const cacheKey = `${branch}\u0000${headSha}`;
  const cached = cachedTaskCi(cache, branch, headSha);
  if (cached) return makeTaskCiReceipt(context, branch, headSha, cached);
  const inFlight = cache.inFlight.get(cacheKey);
  if (inFlight) return makeTaskCiReceipt(context, branch, headSha, await inFlight);
  const reportPromise = (async () => {
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
    // One jobs read per latest workflow/event run; they are independent, so they run together
    // (measured: serial was the largest segment of a cold task-ci read).
    const runs = await Promise.all(
      [...latest.values()].map(async (run) => {
        const pages = await api<readonly { readonly jobs: readonly Job[] }[]>(
          `${prefix}actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
          true,
        );
        const jobs = [];
        for (const job of pages.flatMap((page) => page.jobs)) {
          let failure: TaskCiJobFailure | null = null;
          if (job.conclusion === "failure" && run.status === "completed" && job.status === "completed") {
            try {
              const log = await runCommand(["api", "--allow-escape-sequences", `${prefix}actions/jobs/${job.id}/logs`]);
              failure = { ...extractJobFailure(log), logUrl: job.html_url };
            } catch (error) {
              // One job's missing log must not sink the whole read; the report names why it is absent.
              const detail = error instanceof Error ? error.message : String(error);
              consumeKnownError(error);
              failure = {
                ...emptyJobFailure(),
                logUrl: job.html_url,
                unavailable: `raw job log unavailable: ${detail.slice(0, 300)}`,
              };
            }
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
        return {
          id: run.id,
          attempt: run.run_attempt,
          event: run.event,
          status: run.status,
          conclusion: run.conclusion,
          url: run.html_url,
          jobs,
        };
      }),
    );
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
    const notStarted =
      conclusion !== "not_started" ? undefined : await explainNotStarted(api, prefix, repository, branch);
    const ci: TaskCiReport = {
      schema: "task-ci/v2",
      taskId: branch,
      branch,
      headSha,
      conclusion,
      ...(notStarted ? { notStarted } : {}),
      checks,
      runs,
    };
    cache.reports.set(cacheKey, { expiresAt: Date.now() + ciReportTtlMs, ci });
    return ci;
  })();
  cache.inFlight.set(cacheKey, reportPromise);
  try {
    return makeTaskCiReceipt(context, branch, headSha, await reportPromise);
  } finally {
    cache.inFlight.delete(cacheKey);
  }
}

function makeTaskCiReceipt(
  context: Pick<RepoCellApiContext, "projection"> & {
    readonly readResult?: RepoCellApiContext["extracted"]["readResult"];
  },
  branch: string,
  headSha: string,
  ci: TaskCiReport,
) {
  const revision = context.projection.readCut().sourceRevision;
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

type ObservationTaskCiContext = Pick<RepoCellApiContext, "projection" | "now" | "cellCodedError"> & {
  readonly store?: { readonly readContentBlob: (sha256: string) => Uint8Array | null };
  readonly readResult?: RepoCellApiContext["extracted"]["readResult"];
};

/** Build task-ci from the center observation cut. Provider credentials are intentionally absent here. */
function readTaskCiFromObservations(
  context: ObservationTaskCiContext,
  taskId: string,
  _action: RepoTaskAction,
): WriteReceiptDraft & { readonly ci: TaskCiReport } {
  const snapshot = context.projection.read(taskId).snapshot as {
      readonly task?: { readonly iteration?: number } | null;
      readonly executions?: readonly {
        readonly iteration?: number;
        readonly submission?: { readonly commitSha?: string | null } | null;
      }[];
    },
    execution = snapshot.executions?.find(
      (candidate) => candidate.iteration === snapshot.task?.iteration && candidate.submission !== null,
    ),
    headSha = execution?.submission?.commitSha ?? null;
  if (!headSha)
    return makeTaskCiReceipt(context, taskId, "", {
      schema: "task-ci/v2",
      taskId,
      branch: taskId,
      headSha: "",
      conclusion: "not_started",
      notStarted: {
        reason: "queued",
        detail: `Task ${taskId} has no submitted delivery yet; submit the task before reading its CI.`,
      },
      checks: [],
      runs: [],
    });
  const cut = context.projection.readCiRunObservations(2000),
    projectionPending = cut.status !== "ready";
  if (projectionPending)
    return makeTaskCiReceipt(context, taskId, headSha, {
      schema: "task-ci/v2",
      taskId,
      branch: taskId,
      headSha,
      conclusion: "pending",
      checks: [],
      runs: [],
    });
  const events = cut.events.filter((event) => event.payload.run.branch === taskId && event.payload.run.sha === headSha),
    groups = new Map<string, CiObservationRead[]>();
  for (const event of events) {
    const key = event.payload.run.runId,
      group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }
  const runs = [...groups.values()]
      .sort((left, right) => (right[0]?.workspaceRevision ?? 0) - (left[0]?.workspaceRevision ?? 0))
      .map((group) => observationRunReport(context, group)),
    checks = runs.flatMap((run) =>
      run.jobs.map((job) => ({ name: job.name, status: job.status, conclusion: job.conclusion, url: job.url })),
    ),
    conclusion =
      runs.length === 0
        ? "not_started"
        : runs.some((run) => run.status !== "completed")
          ? "pending"
          : runs.some((run) => run.conclusion === "failure")
            ? "failure"
            : "success";
  const ci: TaskCiReport = {
    schema: "task-ci/v2",
    taskId,
    branch: taskId,
    headSha,
    conclusion,
    ...(runs.length === 0
      ? {
          notStarted: {
            reason: "queued" as const,
            detail: `No completed CI observation for ${headSha} is visible at center revision ${cut.sourceRevision}; read again after the observer runs.`,
          },
        }
      : {}),
    checks,
    runs,
  };
  return makeTaskCiReceipt(context, taskId, headSha, ci);
}

function observationRunReport(
  context: ObservationTaskCiContext,
  events: readonly CiObservationRead[],
): TaskCiReport["runs"][number] {
  const workflow = events.find((event) => event.payload.scope === "workflow"),
    attempt = events.find((event) => event.payload.scope === "attempt"),
    jobEvents = events.filter((event) => event.payload.scope === "job"),
    jobs = new Map<string, TaskCiReport["runs"][number]["jobs"][number]>();
  for (const event of jobEvents) {
    const id = event.payload.identity.jobExecutionId ?? event.payload.identity.jobKey ?? event.eventId,
      detail = readObservationDetail(context, event),
      failed =
        event.payload.failedTests.length > 0 ||
        event.payload.fileOutcomes.length > 0 ||
        detail?.tests.some((test) => test.status === "failed") === true ||
        (detail?.fileOutcomes !== undefined && detail.fileOutcomes.length > 0) ||
        detail?.diagnostics.some((value) => {
          if (typeof value !== "object" || value === null) return false;
          const kind = (value as { readonly kind?: unknown }).kind;
          return kind === "ci-failure" || kind === "ci-failure-excerpt";
        }) === true;
    jobs.set(id, {
      id: Number.isSafeInteger(Number(id)) ? Number(id) : 0,
      name: event.payload.run.job,
      status: "completed",
      conclusion: failed ? "failure" : "success",
      url: "",
      failure: failed ? failureFromObservation(event, detail) : null,
    });
  }
  for (const inventory of attempt?.payload.attemptInventory?.jobs ?? []) {
    if (jobs.has(inventory.jobExecutionId)) continue;
    jobs.set(inventory.jobExecutionId, {
      id: Number.isSafeInteger(Number(inventory.jobExecutionId)) ? Number(inventory.jobExecutionId) : 0,
      name: inventory.name,
      status: "completed",
      conclusion: inventory.conclusion === "failure" ? "failure" : inventory.conclusion,
      url: "",
      failure:
        inventory.conclusion === "failure"
          ? {
              testFiles: [],
              tests: [],
              errors: [],
              excerpt: "",
              truncated: false,
              logUrl: "",
              unavailable: "center has no CI detail blob for this failed job",
            }
          : null,
    });
  }
  const runConclusion =
    workflow?.payload.verification?.conclusion ??
    ([...jobs.values()].some((job) => job.conclusion === "failure") ? "failure" : "success");
  return {
    id: Number.parseInt(events[0]?.payload.identity.databaseRunId ?? "0", 10) || 0,
    attempt: events[0]?.payload.identity.runAttempt ?? 1,
    event: workflow?.payload.verification?.event ?? "pull_request",
    status: "completed",
    conclusion: runConclusion,
    url: "",
    jobs: [...jobs.values()],
  };
}

function readObservationDetail(context: ObservationTaskCiContext, event: CiObservationRead): CiRunDetail | null {
  const ref = event.payload.detailRef;
  if (!ref) return null;
  const bytes = context.store?.readContentBlob(ref.sha256);
  if (!bytes) return null;
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as CiRunDetail;
}

function failureFromObservation(event: CiObservationRead, detail: CiRunDetail | null): TaskCiJobFailure {
  const tests = [
      ...new Set([
        ...event.payload.failedTests.map((test) => test.name),
        ...(detail?.tests.filter((test) => test.status === "failed").map((test) => test.name) ?? []),
      ]),
    ],
    testFiles = [
      ...new Set([
        ...event.payload.failedTests.map((test) => test.file),
        ...(detail?.tests.filter((test) => test.status === "failed").map((test) => test.file) ?? []),
      ]),
    ],
    errors = (detail?.diagnostics ?? [])
      .filter(
        (
          value,
        ): value is {
          readonly kind: "ci-failure";
          readonly test: string;
          readonly firstLine: string;
          readonly frames?: readonly string[];
        } =>
          typeof value === "object" &&
          value !== null &&
          (value as { readonly kind?: unknown }).kind === "ci-failure" &&
          typeof (value as { readonly test?: unknown }).test === "string" &&
          typeof (value as { readonly firstLine?: unknown }).firstLine === "string",
      )
      .map((value) => ({ test: value.test, firstLine: value.firstLine, frames: value.frames ?? [] })),
    excerpt = (detail?.diagnostics ?? []).find(
      (value): value is { readonly kind: "ci-failure-excerpt"; readonly excerpt: string } =>
        typeof value === "object" &&
        value !== null &&
        (value as { readonly kind?: unknown }).kind === "ci-failure-excerpt" &&
        typeof (value as { readonly excerpt?: unknown }).excerpt === "string",
    );
  return {
    testFiles,
    tests,
    errors,
    excerpt: excerpt?.excerpt ?? "",
    truncated:
      event.payload.failedTests.some((test) => test.truncated === true) ||
      detail?.tests.some((test) => test.truncated === true) === true,
    logUrl: "",
    ...(detail ? {} : { unavailable: "center CI detail blob is unavailable at this replica cut" }),
  };
}

async function hasOriginRemote(rootDir: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", rootDir, "remote", "get-url", "origin"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

type ApiReader = <T>(endpoint: string, paginated?: boolean) => Promise<T>;

async function explainNotStarted(
  api: ApiReader,
  prefix: string,
  repository: string,
  branch: string,
): Promise<NonNullable<TaskCiReport["notStarted"]>> {
  const [owner] = repository.split("/");
  const pulls = await api<readonly { readonly number: number; readonly mergeable_state: string | null }[]>(
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

async function readGitLabTaskCi(
  context: Pick<RepoCellApiContext, "projection" | "now" | "cellCodedError"> & {
    readonly rootDir: string;
    readonly readResult?: RepoCellApiContext["extracted"]["readResult"];
  },
  action: RepoTaskAction,
  hosting: Extract<HostingProvider, { readonly kind: "gitlab" }>,
  token: string,
  redact: (text: string) => string,
): Promise<WriteReceiptDraft & { readonly ci: TaskCiReport }> {
  const branch = String(action.taskId);
  const request = async <T>(path: string): Promise<T> => {
    const response = await fetch(`${hosting.apiBaseUrl}/projects/${encodeURIComponent(hosting.projectPath)}${path}`, {
      headers: { "PRIVATE-TOKEN": token },
    });
    if (!response.ok)
      throw context.cellCodedError(
        "task_ci_read_failed",
        redact(`GitLab API ${response.status}: ${await response.text()}`).slice(0, 2048),
      );
    return (await response.json()) as T;
  };
  const branchInfo = await request<{ readonly commit: { readonly id: string } }>(
    `/repository/branches/${encodeURIComponent(branch)}`,
  );
  const headSha = branchInfo.commit.id;
  const cache = taskCiCache(context.projection),
    cacheKey = `${branch}\u0000${headSha}`,
    cached = cachedTaskCi(cache, branch, headSha);
  if (cached) return makeTaskCiReceipt(context, branch, headSha, cached);
  type Pipeline = { id: number; status: string; ref: string; sha: string; web_url?: string; source?: string };
  const pipelines = await request<readonly Pipeline[]>(
    `/pipelines?sha=${encodeURIComponent(headSha)}&ref=${encodeURIComponent(branch)}&per_page=100`,
  );
  const latest = [...pipelines]
    .filter((run) => run.sha === headSha && run.ref === branch)
    .sort((a, b) => b.id - a.id)
    .slice(0, 1);
  const runs: TaskCiReport["runs"][number][] = [];
  for (const pipeline of latest) {
    type Job = {
      id: number;
      name: string;
      status: string;
      failure_reason?: string | null;
      web_url?: string;
      allow_failure?: boolean;
    };
    const jobs = await request<readonly Job[]>(`/pipelines/${pipeline.id}/jobs?per_page=100`);
    const mapped = [];
    for (const job of jobs) {
      let failure: TaskCiJobFailure | null = null;
      if (job.status === "failed") {
        const response = await fetch(
          `${hosting.apiBaseUrl}/projects/${encodeURIComponent(hosting.projectPath)}/jobs/${job.id}/trace`,
          {
            headers: { "PRIVATE-TOKEN": token },
          },
        );
        failure = {
          ...(response.ok
            ? extractJobFailure((await response.text()).replaceAll(token, "[REDACTED]"))
            : {
                ...emptyJobFailure(),
                unavailable: `GitLab trace unavailable (${response.status})`,
              }),
          logUrl: job.web_url ?? `${hosting.apiBaseUrl}/jobs/${job.id}`,
        };
      }
      mapped.push({
        id: job.id,
        name: job.name,
        status: job.status,
        conclusion: job.status === "success" ? "success" : job.status === "failed" ? "failure" : null,
        url: job.web_url ?? `${hosting.apiBaseUrl}/jobs/${job.id}`,
        failure,
      });
    }
    runs.push({
      id: pipeline.id,
      attempt: pipeline.id,
      event: pipeline.source ?? "push",
      status:
        pipeline.status === "success" || pipeline.status === "failed" || pipeline.status === "canceled"
          ? "completed"
          : pipeline.status,
      conclusion: pipeline.status === "success" ? "success" : pipeline.status === "failed" ? "failure" : null,
      url: pipeline.web_url ?? `${hosting.apiBaseUrl}/pipelines/${pipeline.id}`,
      jobs: mapped,
    });
  }
  const checks = runs.flatMap((run) =>
    run.jobs.map((job) => ({ name: job.name, status: job.status, conclusion: job.conclusion, url: job.url })),
  );
  const conclusion =
    runs.length === 0
      ? "not_started"
      : runs.some((run) => run.status !== "completed")
        ? "pending"
        : runs.every((run) => run.conclusion === "success")
          ? "success"
          : "failure";
  const ci: TaskCiReport = { schema: "task-ci/v2", taskId: branch, branch, headSha, conclusion, checks, runs };
  cache.reports.set(cacheKey, { expiresAt: Date.now() + ciReportTtlMs, ci });
  return makeTaskCiReceipt(context, branch, headSha, ci);
}

/** What a red job's raw log says, in the runner's own vocabulary: the files that did not pass
 * (`[node-test-file]` lines from tools/run-node-tests.mjs), the failed test names (spec-reporter
 * `✖` lines), and each failure's error first line with its first stack frames. */
export interface TaskCiJobFailure {
  readonly testFiles: readonly string[];
  readonly tests: readonly string[];
  readonly errors: readonly {
    readonly test: string;
    readonly firstLine: string;
    readonly frames: readonly string[];
  }[];
  /** Fallback context for jobs with no runner markers (a gate or setup failure); empty otherwise. */
  readonly excerpt: string;
  readonly truncated: boolean;
  readonly logUrl: string;
  readonly unavailable?: string;
}

/** Keep submit rejections actionable without returning provider logs or unbounded diagnostics. */
export function formatTaskCiFailure(ci: TaskCiReport): string {
  const lines: string[] = [];
  for (const run of ci.runs) {
    for (const job of run.jobs) {
      if (job.conclusion !== "failure") continue;
      lines.push(`failed job ${job.name}`);
      const failure = job.failure;
      if (!failure) continue;
      if (failure.tests.length) lines.push(`failed tests: ${failure.tests.join(", ")}`);
      for (const error of failure.errors) lines.push(`error: ${error.firstLine} (${error.test})`);
      if (!failure.errors.length && failure.excerpt) lines.push(`error excerpt: ${failure.excerpt}`);
      if (failure.unavailable) lines.push(`detail unavailable: ${failure.unavailable}`);
    }
  }
  return lines.join("\n").slice(0, 4096);
}

function emptyJobFailure(): Omit<TaskCiJobFailure, "logUrl"> {
  return { testFiles: [], tests: [], errors: [], excerpt: "", truncated: false };
}

/** Extract failed test files, names and error context from a raw job log. Every bound keeps the
 * report short; `truncated` says when one was hit. The spec reporter prints the error block only in
 * its end-of-run recap, so a `✖` line seen inline carries no error and the recap block fills it in. */
export function extractJobFailure(log: string): Omit<TaskCiJobFailure, "logUrl" | "unavailable"> {
  return extractCiFailure(log);
}
