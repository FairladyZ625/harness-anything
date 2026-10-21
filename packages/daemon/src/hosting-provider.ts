import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { readSettingsFacet, resolveHarnessLayout } from "@harness-anything/kernel";

const execFileAsync = promisify(execFile);

export type HostingProvider =
  | { readonly kind: "github"; readonly host: string; readonly repository: string }
  | { readonly kind: "gitlab"; readonly host: string; readonly projectPath: string; readonly apiBaseUrl: string };

export type HostingProviderKind = HostingProvider["kind"];

/**
 * The one configuration sentence doctor health, dispatch receipts, and credential-unavailable
 * errors print. Every surface that tells a person how to bind the daemon-held credential
 * renders this string, so the advice cannot drift between the place that diagnoses the gap
 * and the place that hit it.
 */
export function hostingCredentialConfigurationAdvice(
  provider: HostingProviderKind,
  instanceId = "<instance-id>",
): string {
  const scopes =
    provider === "github"
      ? "the token needs repository contents write for task pushes and Actions read for CI"
      : "the token needs write_repository for pushes and read_api for pipelines, jobs, and traces";
  return `ha runtime instance hosting-credential set ${instanceId} --provider ${provider} --ref <opaque-reference>; ${scopes}`;
}

export async function detectHostingProvider(
  rootDir: string,
  declaration?: { readonly provider?: "github" | "gitlab"; readonly host?: string },
  allowUnknown = false,
): Promise<HostingProvider> {
  let remote: string;
  try {
    remote = String(
      (await execFileAsync("git", ["-C", rootDir, "remote", "get-url", "origin"], { timeout: 10_000 })).stdout,
    ).trim();
  } catch {
    if (allowUnknown) return null as never;
    throw unknownHostingProvider();
  }
  const authoredRoot = resolveHarnessLayout(rootDir).authoredRoot;
  let settings = declaration;
  const settingsPath = path.join(authoredRoot, "harness.yaml");
  if (!settings && existsSync(settingsPath))
    settings = (
      readSettingsFacet(readFileSync(settingsPath, "utf8")) as unknown as {
        hosting?: { provider?: "github" | "gitlab"; host?: string };
      }
    ).hosting;
  try {
    return hostingProviderFromRemote(remote, settings);
  } catch (error) {
    if (
      allowUnknown &&
      error instanceof Error &&
      (error as Error & { code?: string }).code === "hosting_provider_unknown"
    )
      return null as never;
    throw error;
  }
}

export async function hasOriginRemote(rootDir: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", rootDir, "remote", "get-url", "origin"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export function hostingProviderFromRemote(
  remote: string,
  declaration?: { readonly provider?: "github" | "gitlab"; readonly host?: string },
): HostingProvider {
  const parsed = parseRemote(remote);
  const host = declaration?.host ?? parsed.host;
  const kind =
    declaration?.provider ?? (host === "github.com" ? "github" : host === "gitlab.com" ? "gitlab" : undefined);
  if (!kind || !host || !parsed.path) throw unknownHostingProvider();
  if (kind === "github") return { kind, host, repository: parsed.path };
  return { kind, host, projectPath: parsed.path, apiBaseUrl: `https://${host}/api/v4` };
}

/** One CI check on a pull request's current head, already folded to a four-word verdict. */
export type HostingCheckState = "pending" | "passed" | "failed" | "skipped";

export type HostingCheck = {
  readonly name: string;
  readonly state: HostingCheckState;
  readonly url: string | null;
};

export type HostingChecksSnapshot = {
  /** The pull request (or merge request) web URL the checks belong to. */
  readonly subjectUrl: string | null;
  /** The commit the provider currently reports as the pull request head. */
  readonly headSha: string | null;
  readonly checks: readonly HostingCheck[];
};

export type HostingChecksQuery = {
  readonly branch: string;
  readonly env: NodeJS.ProcessEnv;
  /** The repository root: the GitHub reader infers the repository from this checkout. */
  readonly cwd: string;
};

export type HostingProviderRunner = (args: readonly string[], env: NodeJS.ProcessEnv, cwd: string) => Promise<string>;

export type HostingChecksApiCall = (
  url: string,
  token: string,
) => Promise<{ readonly status: number; readonly body: unknown; readonly nextPage: string | null }>;

/**
 * Reads the checks of the open pull request (GitHub) or merge request (GitLab) whose head branch is
 * `query.branch`. This is the hosting port's read face for CI state: callers poll through it and
 * never hand-roll provider HTTP. A missing pull request is `ci_pull_request_missing`; an
 * unreachable provider API is `hosting_checks_unavailable`.
 */
export async function readHostingChecks(
  provider: HostingProvider,
  query: HostingChecksQuery,
  deps: { readonly runProvider?: HostingProviderRunner; readonly fetchJson?: HostingChecksApiCall } = {},
): Promise<HostingChecksSnapshot> {
  if (provider.kind === "github") return readGitHubChecks(query, deps.runProvider ?? runGhProvider);
  return readGitLabChecks(provider, query, deps.fetchJson ?? fetchGitLabApi);
}

async function runGhProvider(args: readonly string[], env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  return String(
    (await execFileAsync("gh", args, { cwd, env, timeout: 30_000, maxBuffer: 2 << 20, windowsHide: true })).stdout,
  );
}

async function fetchGitLabApi(
  url: string,
  token: string,
): Promise<{
  readonly status: number;
  readonly body: unknown;
  readonly nextPage: string | null;
}> {
  const response = await fetch(url, {
    headers: { "PRIVATE-TOKEN": token },
    signal: AbortSignal.timeout(30_000),
    redirect: "follow",
  });
  return { status: response.status, body: await response.json(), nextPage: response.headers.get("X-Next-Page") };
}

async function readGitHubChecks(
  query: HostingChecksQuery,
  runProvider: HostingProviderRunner,
): Promise<HostingChecksSnapshot> {
  let raw: string;
  try {
    raw = await runProvider(
      ["pr", "view", query.branch, "--json", "url,headRefOid,statusCheckRollup"],
      query.env,
      query.cwd,
    );
  } catch (error) {
    throw missingGitHubPullRequest(error);
  }
  try {
    return hostingChecksFromGitHub(JSON.parse(raw));
  } catch (error) {
    if (error instanceof Error && (error as Error & { code?: string }).code === "ci_pull_request_missing") throw error;
    throw hostingChecksUnavailable(`GitHub check rollup could not be parsed: ${String(error)}`);
  }
}

function missingGitHubPullRequest(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return /no pull requests found|could not resolve to a pull request/u.test(message)
    ? codedHostingError("ci_pull_request_missing", `No pull request is open for this branch: ${message}`)
    : error instanceof Error
      ? error
      : new Error(String(error));
}

/** Folds a `gh pr view --json statusCheckRollup` payload into the snapshot shape. Unknown rollup
 * entries read as pending: an unrecognized shape never claims green or red. */
export function hostingChecksFromGitHub(payload: unknown): HostingChecksSnapshot {
  if (!isRecord(payload)) throw hostingChecksUnavailable("GitHub check rollup is not an object.");
  const rollup = Array.isArray(payload.statusCheckRollup) ? payload.statusCheckRollup : [];
  return {
    subjectUrl: typeof payload.url === "string" ? payload.url : null,
    headSha: typeof payload.headRefOid === "string" ? payload.headRefOid : null,
    checks: latestCheckInstances(rollup).map((entry) => (isRecord(entry) ? githubCheck(entry) : pendingUnknownCheck())),
  };
}

/** GitHub lists every check-run instance a head has carried, so a superseded run of the same
 * check must not outvote the run that replaced it: a PR-body edit re-triggers its workflow on an
 * unchanged SHA, and a concurrency cancel retires the older instance as a failure-shaped entry.
 * Keeping the latest-started instance per check name reproduces the summary the pull-request
 * page shows. Entries without a check-run start time — commit statuses, unknown shapes — pass
 * through untouched; they are already single-instance in the rollup. */
function latestCheckInstances(rollup: readonly unknown[]): readonly unknown[] {
  const slots = new Map<string, { slot: number; startedAt: string }>();
  const output: unknown[] = [];
  for (const candidate of rollup) {
    const record = isRecord(candidate) ? candidate : null,
      name = typeof record?.name === "string" ? record.name : typeof record?.context === "string" ? record.context : "",
      startedAt = typeof record?.startedAt === "string" ? record.startedAt : null;
    if (!record || !name || startedAt === null) {
      output.push(candidate);
      continue;
    }
    const kept = slots.get(name);
    if (kept === undefined) {
      slots.set(name, { slot: output.length, startedAt });
      output.push(candidate);
    } else if (startedAt >= kept.startedAt) {
      output[kept.slot] = candidate;
      kept.startedAt = startedAt;
    }
  }
  return output;
}

function githubCheck(entry: Readonly<Record<string, unknown>>): HostingCheck {
  const name = typeof entry.name === "string" ? entry.name : typeof entry.context === "string" ? entry.context : "",
    url =
      typeof entry.detailsUrl === "string"
        ? entry.detailsUrl
        : typeof entry.targetUrl === "string"
          ? entry.targetUrl
          : null;
  if (entry.__typename === "StatusContext")
    return {
      name,
      url,
      state:
        entry.state === "SUCCESS"
          ? "passed"
          : entry.state === "FAILURE" || entry.state === "ERROR"
            ? "failed"
            : "pending",
    };
  if (entry.status !== "COMPLETED") return { name, url, state: "pending" };
  return {
    name,
    url,
    state:
      entry.conclusion === "SUCCESS"
        ? "passed"
        : entry.conclusion === "SKIPPED" || entry.conclusion === "NEUTRAL"
          ? "skipped"
          : "failed",
  };
}

function pendingUnknownCheck(): HostingCheck {
  return { name: "", state: "pending", url: null };
}

const gitlabJobPageLimit = 10;

async function readGitLabChecks(
  provider: HostingProvider & { readonly kind: "gitlab" },
  query: HostingChecksQuery,
  fetchJson: HostingChecksApiCall,
): Promise<HostingChecksSnapshot> {
  const token = typeof query.env.GITLAB_TOKEN === "string" ? query.env.GITLAB_TOKEN : "";
  if (!token)
    throw codedHostingError(
      "hosting_checks_unavailable",
      "No GitLab token is available to read merge request checks (GITLAB_TOKEN).",
    );
  const project = encodeURIComponent(provider.projectPath),
    redact = (text: string) => text.replaceAll(token, "[REDACTED]"),
    answered = async (url: string) => {
      const response = await fetchJson(url, token);
      if (response.status !== 200)
        throw hostingChecksUnavailable(`GitLab API answered ${String(response.status)} for ${url}`, redact);
      return response;
    };
  let mergeRequests: unknown;
  try {
    ({ body: mergeRequests } = await answered(
      `${provider.apiBaseUrl}/projects/${project}/merge_requests?source_branch=${encodeURIComponent(query.branch)}&state=opened`,
    ));
  } catch (error) {
    throw error instanceof Error && (error as Error & { code?: string }).code
      ? error
      : hostingChecksUnavailable(`GitLab merge request lookup failed: ${errorText(error)}`, redact);
  }
  const mergeRequest = (Array.isArray(mergeRequests) ? mergeRequests : []).find(isRecord);
  if (!mergeRequest)
    throw codedHostingError(
      "ci_pull_request_missing",
      `No open GitLab merge request exists for branch ${query.branch}.`,
    );
  const pipeline = isRecord(mergeRequest.head_pipeline) ? mergeRequest.head_pipeline : null;
  return {
    subjectUrl: typeof mergeRequest.web_url === "string" ? mergeRequest.web_url : null,
    headSha: typeof mergeRequest.sha === "string" ? mergeRequest.sha : null,
    checks:
      pipeline && Number.isSafeInteger(pipeline.id)
        ? await gitlabPipelineJobs(provider.apiBaseUrl, project, pipeline, answered, redact)
        : [],
  };
}

async function gitlabPipelineJobs(
  apiBaseUrl: string,
  project: string,
  pipeline: Readonly<Record<string, unknown>>,
  answered: (
    url: string,
  ) => Promise<{ readonly status: number; readonly body: unknown; readonly nextPage: string | null }>,
  redact: (text: string) => string,
): Promise<readonly HostingCheck[]> {
  const checks: HostingCheck[] = [];
  for (let page = 1; page <= gitlabJobPageLimit; page++) {
    let response: { readonly status: number; readonly body: unknown; readonly nextPage: string | null };
    try {
      response = await answered(
        `${apiBaseUrl}/projects/${project}/pipelines/${String(pipeline.id)}/jobs?per_page=100&page=${String(page)}`,
      );
    } catch (error) {
      throw error instanceof Error && (error as Error & { code?: string }).code
        ? error
        : hostingChecksUnavailable(`GitLab pipeline jobs lookup failed: ${errorText(error)}`, redact);
    }
    for (const job of Array.isArray(response.body) ? response.body : [])
      if (isRecord(job)) checks.push(gitlabJobCheck(job));
    if (response.nextPage === null || response.nextPage === "") return checks;
  }
  return checks;
}

function gitlabJobCheck(job: Readonly<Record<string, unknown>>): HostingCheck {
  const status = typeof job.status === "string" ? job.status : "";
  return {
    name: typeof job.name === "string" ? job.name : "",
    url: typeof job.web_url === "string" ? job.web_url : null,
    // An allow_failure failure does not hold the pipeline red; it reads as skipped.
    state:
      status === "success"
        ? "passed"
        : status === "failed"
          ? job.allow_failure === true
            ? "skipped"
            : "failed"
          : status === "canceled" || status === "skipped" || status === "manual"
            ? "skipped"
            : "pending",
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codedHostingError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function hostingChecksUnavailable(message: string, redact?: (text: string) => string): Error {
  return codedHostingError("hosting_checks_unavailable", redact ? redact(message) : message);
}

function parseRemote(remote: string): { readonly host: string; readonly path: string } {
  const value = remote.trim().replace(/\.git$/u, "");
  const ssh = /^(?:ssh:\/\/)?git@([^/:]+)(?::\d+)?(?::|\/)(.+)$/u.exec(value);
  if (ssh) return { host: ssh[1]!, path: ssh[2]!.replace(/^\/+|\/+$/gu, "") };
  try {
    const url = new URL(value);
    return { host: url.hostname, path: url.pathname.replace(/^\/+|\/+$/gu, "") };
  } catch {
    return { host: "", path: "" };
  }
}

function unknownHostingProvider(): Error {
  const error = new Error(
    "Unable to identify the repository hosting provider. Set hosting.provider and hosting.host in repository settings for GitHub or GitLab.",
  );
  Object.assign(error, { code: "hosting_provider_unknown" });
  return error;
}
