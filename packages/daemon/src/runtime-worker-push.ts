import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";
import { consumeKnownError } from "../../kernel/src/index.ts";
import { scrubProviderValue } from "./dispatch-stream.ts";

const execFileAsync = promisify(execFile),
  workerBranchPattern = /^codex\/[A-Za-z0-9][A-Za-z0-9._-]*$/u,
  detailLimit = 512,
  // Porcelain output grows with the worktree, and the dirty worktrees this answers about are the
  // large ones. Anything past this bound is still an answer: a worktree that says that much is dirty.
  worktreeStatusLimit = 1 << 20;

export type WorkerPushResult =
  | { readonly attempted: false; readonly reason: "not-a-worker-worktree" | "not-codex-branch" | "detached" }
  | { readonly attempted: true; readonly ok: true; readonly branch: string }
  | { readonly attempted: true; readonly ok: false; readonly branch: string | null; readonly detail: string };

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
}): Promise<WorkerPushResult> {
  if (samePath(input.cwd, input.canonicalRoot)) return { attempted: false, reason: "not-a-worker-worktree" };

  let branch: string;
  try {
    const env = { ...process.env, ...input.env, GIT_TERMINAL_PROMPT: "0" },
      invocation = gitInvocation(input.cwd, ["branch", "--show-current"], env),
      result = await execFileAsync(invocation.command, invocation.args, {
        env,
        maxBuffer: detailLimit * 2,
        windowsHide: true,
        ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
    branch = String(result.stdout).trim();
  } catch (error) {
    return { attempted: true, ok: false, branch: null, detail: errorDetail(error) };
  }
  if (!branch) return { attempted: false, reason: "detached" };
  if (!workerBranchPattern.test(branch)) return { attempted: false, reason: "not-codex-branch" };

  try {
    const env = { ...process.env, ...input.env, GIT_TERMINAL_PROMPT: "0" },
      invocation = gitInvocation(input.cwd, ["push", "--force-with-lease", "origin", `HEAD:${branch}`], env);
    await execFileAsync(invocation.command, invocation.args, {
      env,
      maxBuffer: detailLimit * 2,
      windowsHide: true,
      ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    return { attempted: true, ok: true, branch };
  } catch (error) {
    return { attempted: true, ok: false, branch, detail: errorDetail(error) };
  }
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
