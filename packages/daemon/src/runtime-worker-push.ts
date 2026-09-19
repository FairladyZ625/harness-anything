import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";
import { consumeKnownError } from "../../kernel/src/index.ts";
import { scrubProviderValue } from "./dispatch-stream.ts";

const execFileAsync = promisify(execFile),
  workerBranchPattern = /^codex\/[A-Za-z0-9][A-Za-z0-9._-]*$/u,
  detailLimit = 512,
  // One formatted line per commit; a rebased worker branch carries every recreated commit again.
  workerHistoryLimit = 1 << 20,
  // Porcelain output grows with the worktree, and the dirty worktrees this answers about are the
  // large ones. Anything past this bound is still an answer: a worktree that says that much is dirty.
  worktreeStatusLimit = 1 << 20,
  // Settlement pushes inside the repository write queue, so a stalled remote or a credential dialog
  // nobody answers holds every write to the repo. A code-only worker branch pushes in seconds; this
  // is the bound the fleet edge gives its own network transfers.
  workerPushTimeoutMs = 60_000;

export type WorkerPushResult =
  | { readonly attempted: false; readonly reason: "not-a-worker-worktree" | "not-codex-branch" | "detached" }
  | { readonly attempted: true; readonly ok: true; readonly branch: string; readonly head: string }
  | {
      readonly attempted: true;
      readonly ok: false;
      readonly branch: string | null;
      readonly head: string | null;
      readonly detail: string;
    };

export type WorkerGitIdentity = {
  readonly name: string;
  readonly email: string;
};

// The conventional worker identity has exactly one source: the git config the canonical
// repository itself resolves (`git config user.name/user.email` at the canonical root, local
// values over global ones). Worker worktrees share that config, so this states explicitly the
// identity a worker would otherwise inherit implicitly, and no repo setting duplicates it.
export async function readWorkerGitIdentity(input: {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<WorkerGitIdentity | null> {
  const env = gitEnvironment(input.env);
  try {
    const name = (await readGitText(input.cwd, ["config", "--get", "user.name"], env)).trim(),
      email = (await readGitText(input.cwd, ["config", "--get", "user.email"], env)).trim();
    return name && email ? { name, email } : null;
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
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

// Read-only: settlement observes the worktree, it never commits, stashes or cleans it. A worktree
// git refuses to describe is not a clean worktree, so an unreadable one answers "dirty" rather than
// letting the failure escape and strand the dispatch without a terminal outcome.
export async function workerWorktreeDirty(input: {
  readonly cwd: string;
  readonly canonicalRoot: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  if (samePath(input.cwd, input.canonicalRoot)) return false;
  try {
    const env = { ...process.env, ...input.env, GIT_TERMINAL_PROMPT: "0" },
      invocation = gitInvocation(input.cwd, ["status", "--porcelain"], env),
      result = await execFileAsync(invocation.command, invocation.args, {
        env,
        maxBuffer: worktreeStatusLimit,
        windowsHide: true,
        ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
    return String(result.stdout).trim().length > 0;
  } catch (error) {
    consumeKnownError(error);
    return true;
  }
}

export async function pushWorkerBranch(input: {
  readonly cwd: string;
  readonly canonicalRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}): Promise<WorkerPushResult> {
  if (samePath(input.cwd, input.canonicalRoot)) return { attempted: false, reason: "not-a-worker-worktree" };
  const env = gitEnvironment(input.env);

  let branch: string;
  try {
    branch = (await readGitText(input.cwd, ["branch", "--show-current"], env)).trim();
  } catch (error) {
    return { attempted: true, ok: false, branch: null, head: null, detail: errorDetail(error) };
  }
  if (!branch) return { attempted: false, reason: "detached" };
  if (!workerBranchPattern.test(branch)) return { attempted: false, reason: "not-codex-branch" };

  let head: string;
  try {
    head = (await readGitText(input.cwd, ["rev-parse", "HEAD"], env)).trim();
  } catch (error) {
    return { attempted: true, ok: false, branch, head: null, detail: errorDetail(error) };
  }

  // Settlement is the publication boundary: the push runs only when the conventional identity
  // is readable and every commit the worker added on top of origin/main carries it. Rewriting
  // authorship is a human decision, so a mismatch refuses the push instead of repairing it.
  const identity = await readWorkerGitIdentity({ cwd: input.canonicalRoot, env });
  if (!identity)
    return {
      attempted: true,
      ok: false,
      branch,
      head,
      detail:
        `canonical repository ${input.canonicalRoot} resolves no git user.name/user.email, ` +
        "so the conventional worker identity cannot be verified",
    };
  const mismatch = await firstCommitOutsideConventionalIdentity(input.cwd, identity, env);
  if (mismatch) return { attempted: true, ok: false, branch, head, detail: mismatch };

  const timeoutMs = input.timeoutMs ?? workerPushTimeoutMs;
  try {
    const invocation = gitInvocation(input.cwd, ["push", "--force-with-lease", "origin", `HEAD:${branch}`], env);
    await execFileAsync(invocation.command, invocation.args, {
      env,
      maxBuffer: detailLimit * 2,
      timeout: timeoutMs,
      windowsHide: true,
      ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    return { attempted: true, ok: true, branch, head };
  } catch (error) {
    // execFile marks the child killed only when it enforced the timeout itself.
    const timedOut = typeof error === "object" && error !== null && "killed" in error && error.killed === true;
    return {
      attempted: true,
      ok: false,
      branch,
      head,
      detail: timedOut ? `git push timed out after ${timeoutMs} ms` : errorDetail(error),
    };
  }
}

// The first commit in `origin/main..HEAD` whose author or committer email is not the
// conventional identity, named with both of its emails; null when the whole range matches.
// Without origin/main the worker's own commits cannot be bounded, so that also refuses.
async function firstCommitOutsideConventionalIdentity(
  cwd: string,
  identity: WorkerGitIdentity,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  let log: string;
  try {
    // Newline-separated fields: git itself refuses newline characters inside an ident, so the
    // three-line records cannot fold into each other.
    log = await readGitText(cwd, ["log", "--format=%H%n%ae%n%ce", "origin/main..HEAD"], env, workerHistoryLimit);
  } catch (error) {
    return `worker commits cannot be bounded against origin/main: ${errorDetail(error)}`;
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
