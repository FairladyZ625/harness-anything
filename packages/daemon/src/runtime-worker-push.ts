import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";
import { scrubProviderValue } from "./dispatch-stream.ts";
import { repositoryBaseRef } from "./schedule-occurrence-workspace.ts";

const execFileAsync = promisify(execFile),
  detailLimit = 512,
  // One formatted line per commit; a rebased worker branch carries every recreated commit again.
  workerHistoryLimit = 1 << 20,
  // Settlement pushes inside the repository write queue, so a stalled remote or a credential dialog
  // nobody answers holds every write to the repo. A code-only worker branch pushes in seconds; this
  // is the bound the fleet edge gives its own network transfers.
  workerPushTimeoutMs = 60_000;

export type WorkerPushResult =
  | { readonly attempted: false; readonly reason: "not-a-worker-worktree" | "not-task-branch" | "detached" }
  | {
      readonly attempted: true;
      readonly ok: true;
      readonly branch: string;
      readonly head: string;
      readonly pushedCommit: string;
    }
  | {
      readonly attempted: true;
      readonly ok: false;
      readonly branch: string | null;
      readonly head: string | null;
      readonly pushedCommit: string | null;
      readonly detail: string;
    };

export type WorkerGitIdentity = {
  readonly name: string;
  readonly email: string;
};

/** A repository-diff delivery is a task branch with at least one commit above the repository baseline. */
export async function workerBranchHasDelivery(input: {
  readonly cwd: string;
  readonly canonicalRoot: string;
  readonly taskId: string;
}): Promise<boolean> {
  if (samePath(input.cwd, input.canonicalRoot)) return false;
  const env = gitEnvironment();
  try {
    const branch = (await readGitText(input.cwd, ["branch", "--show-current"], env)).trim(),
      baseRef = repositoryBaseRef(input.canonicalRoot);
    if (branch !== input.taskId || !baseRef) return false;
    return (await readGitText(input.cwd, ["rev-list", "--count", `${baseRef}..HEAD`], env)).trim() !== "0";
  } catch {
    return false;
  }
}

// The conventional worker identity has exactly one source: the git config the canonical
// repository itself resolves (`git config user.name/user.email` at the canonical root, local
// values over global ones). Worker worktrees share that config, so this states explicitly the
// identity a worker would otherwise inherit implicitly, and no repo setting duplicates it.
export async function readWorkerGitIdentity(input: {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<WorkerGitIdentity | null> {
  // `--default ""` makes an unset key an ordinary empty answer instead of exit status 1, so "no
  // identity configured" is a value here and only a git that cannot run at all throws.
  const env = gitEnvironment(input.env),
    name = (await readGitText(input.cwd, ["config", "--get", "--default", "", "user.name"], env)).trim(),
    email = (await readGitText(input.cwd, ["config", "--get", "--default", "", "user.email"], env)).trim();
  return name && email ? { name, email } : null;
}

// Git ranks these four variables above every config file for author and committer, on commits
// and on the commits a rebase recreates, so a worktree-local override cannot displace them.
export function workerGitIdentityEnvironment(identity: WorkerGitIdentity): NodeJS.ProcessEnv {
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
}

// Every worker launch states the conventional git identity as environment instead of leaving
// commits and rebases to whatever the worktree's config resolves to implicitly. A root that
// resolves no identity injects nothing; the settlement push assertion is the boundary that holds.
export async function conventionalWorkerGitEnvironment(canonicalRoot: string): Promise<NodeJS.ProcessEnv> {
  const identity = await readWorkerGitIdentity({ cwd: canonicalRoot });
  return identity ? workerGitIdentityEnvironment(identity) : {};
}

/**
 * Publishes the branch Harness named after the dispatched task (dec_8B3FCCD256CAC5B0BF3CCEDE58 CH1):
 * a checkout on any other branch is somebody's own and stays local.
 */
export async function pushWorkerBranch(input: {
  readonly cwd: string;
  readonly canonicalRoot: string;
  readonly taskId: string;
  readonly submittedCommitSha?: string;
  /** Exact remote cut observed before the current assignment was checked; empty means absent. */
  readonly expectedRemoteCommit?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}): Promise<WorkerPushResult> {
  if (samePath(input.cwd, input.canonicalRoot)) return { attempted: false, reason: "not-a-worker-worktree" };
  const env = gitEnvironment(input.env);

  let branch: string;
  try {
    branch = (await readGitText(input.cwd, ["branch", "--show-current"], env)).trim();
  } catch (error) {
    return { attempted: true, ok: false, branch: null, head: null, pushedCommit: null, detail: errorDetail(error) };
  }
  if (!branch) return { attempted: false, reason: "detached" };
  if (branch !== input.taskId) return { attempted: false, reason: "not-task-branch" };

  let head: string;
  try {
    head = (await readGitText(input.cwd, ["rev-parse", "HEAD"], env)).trim();
  } catch (error) {
    return { attempted: true, ok: false, branch, head: null, pushedCommit: null, detail: errorDetail(error) };
  }
  const pushedCommit = input.submittedCommitSha ?? head;

  // Publication runs only when the conventional identity
  // is readable and every commit the worker added on top of the default branch carries it. Rewriting
  // authorship is a human decision, so a mismatch refuses the push instead of repairing it.
  const identity = await readWorkerGitIdentity({ cwd: input.canonicalRoot, env });
  if (!identity)
    return {
      attempted: true,
      ok: false,
      branch,
      head,
      pushedCommit,
      detail:
        `canonical repository ${input.canonicalRoot} resolves no git user.name/user.email, ` +
        "so the conventional worker identity cannot be verified",
    };
  const mismatch = await firstCommitOutsideConventionalIdentity(
    input.cwd,
    repositoryBaseRef(input.canonicalRoot),
    pushedCommit,
    identity,
    env,
  );
  if (mismatch) return { attempted: true, ok: false, branch, head, pushedCommit, detail: mismatch };

  const timeoutMs = input.timeoutMs ?? workerPushTimeoutMs;
  try {
    const invocation = gitInvocation(
      input.cwd,
      [
        "push",
        input.expectedRemoteCommit === undefined
          ? "--force-with-lease"
          : `--force-with-lease=refs/heads/${branch}:${input.expectedRemoteCommit}`,
        "origin",
        `${pushedCommit}:refs/heads/${branch}`,
      ],
      env,
    );
    await execFileAsync(invocation.command, invocation.args, {
      env,
      maxBuffer: detailLimit * 2,
      timeout: timeoutMs,
      windowsHide: true,
      ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    return { attempted: true, ok: true, branch, head, pushedCommit };
  } catch (error) {
    // execFile marks the child killed only when it enforced the timeout itself.
    const timedOut = typeof error === "object" && error !== null && "killed" in error && error.killed === true;
    return {
      attempted: true,
      ok: false,
      branch,
      head,
      pushedCommit,
      detail: timedOut ? `git push timed out after ${timeoutMs} ms` : errorDetail(error),
    };
  }
}

// The first commit in `<default branch>..HEAD` whose author or committer email is not the
// conventional identity, named with both of its emails; null when the whole range matches.
// Without a default branch the worker's own commits cannot be bounded, so that also refuses.
async function firstCommitOutsideConventionalIdentity(
  cwd: string,
  baseRef: string | null,
  pushedCommit: string,
  identity: WorkerGitIdentity,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  if (!baseRef) return "worker commits cannot be bounded: the repository has no default branch";
  let log: string;
  try {
    // Newline-separated fields: git itself refuses newline characters inside an ident, so the
    // three-line records cannot fold into each other.
    log = await readGitText(
      cwd,
      ["log", "--format=%H%n%ae%n%ce", `${baseRef}..${pushedCommit}`],
      env,
      workerHistoryLimit,
    );
  } catch (error) {
    return `worker commits cannot be bounded against ${baseRef}: ${errorDetail(error)}`;
  }
  const fields = log.split("\n");
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const sha = fields[index]!,
      authorEmail = fields[index + 1]!,
      committerEmail = fields[index + 2]!;
    if (authorEmail !== identity.email || committerEmail !== identity.email)
      return (
        `commit ${sha} carries author <${authorEmail}> and committer ` +
        `<${committerEmail}>, not the conventional identity <${identity.email}>`
      );
  }
  return null;
}

function gitEnvironment(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...process.env, ...extra, GIT_TERMINAL_PROMPT: "0" };
}

async function readGitText(
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  maxBuffer = detailLimit * 2,
): Promise<string> {
  const invocation = gitInvocation(cwd, args, env),
    result = await execFileAsync(invocation.command, invocation.args, {
      env,
      maxBuffer,
      timeout: workerPushTimeoutMs,
      windowsHide: true,
      ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
  return String(result.stdout);
}

function gitInvocation(
  cwd: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): { readonly command: string; readonly args: readonly string[]; readonly windowsVerbatimArguments?: boolean } {
  if (process.platform !== "win32") return { command: "git", args: ["-C", cwd, ...args] };
  const command = ["git", "-C", cwd, ...args].map(quoteWindowsGitArgument).join(" ");
  return {
    command: environment.ComSpec ?? environment.COMSPEC ?? "cmd.exe",
    args: ["/d", "/s", "/c", command],
    windowsVerbatimArguments: true,
  };
}

function quoteWindowsGitArgument(value: string): string {
  return /^[^\s"&|<>^()]+$/u.test(value) ? value : `"${value.replaceAll('"', '\\"')}"`;
}

function samePath(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right);
}

export function canonicalPath(value: string): string {
  try {
    return realpathSync.native(value).replaceAll("\\", "/").replace(/\/+$/u, "");
  } catch {
    return value.replaceAll("\\", "/").replace(/\/+$/u, "");
  }
}

function errorDetail(error: unknown): string {
  const value =
    typeof error === "object" && error !== null && "stderr" in error
      ? String((error as { readonly stderr?: unknown }).stderr ?? "")
      : error instanceof Error
        ? error.message
        : String(error);
  const scrubbed = String(scrubProviderValue(value)).trim().replace(/\s+/gu, " ");
  return scrubbed.slice(0, detailLimit) || "git push failed without diagnostics";
}

/** Observe without updating tracking refs: later background fetches cannot relax this CAS. */
export async function readWorkerRemoteCommit(cwd: string, taskId: string): Promise<string> {
  try {
    const line = await readGitText(cwd, ["ls-remote", "--refs", "origin", `refs/heads/${taskId}`], gitEnvironment());
    return line.trim().split(/\s/u)[0] ?? "";
  } catch (error) {
    throw Object.assign(new Error(errorDetail(error)), { code: "delivery_publish_failed" });
  }
}

/** The center fetches only its configured origin and the task branch, into a request-private ref. */
export async function fetchWorkerDelivery(rootDir: string, taskId: string, requestedCommit?: string): Promise<string> {
  const ref = `refs/harness/delivery/${randomUUID()}`,
    env = gitEnvironment();
  try {
    await readGitText(
      rootDir,
      ["fetch", "--no-tags", "--no-write-fetch-head", "origin", `refs/heads/${taskId}:${ref}`],
      env,
    );
    const commit = (await readGitText(rootDir, ["rev-parse", `${ref}^{commit}`], env)).trim();
    if (requestedCommit !== undefined && requestedCommit !== commit)
      throw new Error(`Requested delivery commit ${requestedCommit} does not match published task branch ${commit}.`);
    const identity = await readWorkerGitIdentity({ cwd: rootDir, env });
    if (!identity) throw new Error("The center repository resolves no conventional Git identity.");
    const mismatch = await firstCommitOutsideConventionalIdentity(
      rootDir,
      repositoryBaseRef(rootDir),
      commit,
      identity,
      env,
    );
    if (mismatch) throw new Error(mismatch);
    return commit;
  } finally {
    await readGitText(rootDir, ["update-ref", "-d", ref], env);
  }
}
