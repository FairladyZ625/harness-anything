import {
  /* @gate-identity check-sync-subprocess/sync-subprocess-014 */
  execFileSync
} from "node:child_process";
import type { VcsCommitAuthor } from "../ports/version-control-system.ts";
import { VcsCommandError } from "../ports/version-control-system.ts";

const gitMaxBuffer = 256 * 1024 * 1024;
let localGitProcesses = 0;

export function recordLocalGitProcess(): void {
  localGitProcesses += 1;
}

export function localGitProcessCount(): number {
  return localGitProcesses;
}

export function runGit(repoRoot: string, ...args: ReadonlyArray<string>): string {
  return runGitAs(repoRoot, undefined, ...args);
}

export function runGitAs(
  repoRoot: string,
  author: VcsCommitAuthor | undefined,
  ...args: ReadonlyArray<string>
): string {
  recordLocalGitProcess();
  const invocation = gitInvocation(repoRoot, args);
  try {
    return (
      /* @gate-identity check-sync-subprocess/sync-subprocess-015 */
      execFileSync(invocation.command, invocation.args, {
        encoding: "utf8",
        maxBuffer: gitMaxBuffer,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        ...(process.platform === "win32" ? { windowsVerbatimArguments: true } : {}),
        env: {
          ...process.env,
          ...(author ? {
            GIT_AUTHOR_NAME: author.name,
            GIT_AUTHOR_EMAIL: author.email,
            GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? author.name,
            GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? author.email
          } : {})
        }
      })
    );
  } catch (error) {
    throw vcsCommandError(error, repoRoot, args[0]);
  }
}

export function localGitText(repoRoot: string, ...args: readonly string[]): string {
  return runGit(repoRoot, ...args);
}

export function localGitBytes(repoRoot: string, args: readonly string[], input?: Uint8Array): Buffer {
  recordLocalGitProcess();
  const invocation = gitInvocation(repoRoot, args);
  try {
    return (
      /* @gate-identity check-sync-subprocess/sync-subprocess-016 */
      execFileSync(invocation.command, invocation.args, {
        input,
        encoding: "buffer",
        maxBuffer: gitMaxBuffer,
        stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
        windowsHide: true,
        ...(process.platform === "win32" ? { windowsVerbatimArguments: true } : {})
      })
    );
  } catch (error) {
    throw vcsCommandError(error, repoRoot, args[0]);
  }
}

export function runGitIndexUpdate(repoRoot: string, input: string): void {
  const invocation = gitInvocation(repoRoot, ["update-index", "-z", "--index-info"]);
  /* @gate-identity check-sync-subprocess/sync-subprocess-017 */
  execFileSync(invocation.command, invocation.args, {
    input: Buffer.from(input),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    ...(process.platform === "win32" ? { windowsVerbatimArguments: true } : {})
  });
}

function gitInvocation(
  repoRoot: string,
  args: readonly string[]
): { readonly command: string; readonly args: readonly string[] } {
  if (process.platform !== "win32") return { command: "git", args: ["-C", repoRoot, ...args] };
  const command = ["git", "-C", repoRoot, ...args].map(quoteWindowsCommandArgument).join(" ");
  return { command: process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe", args: ["/d", "/s", "/c", command] };
}

function quoteWindowsCommandArgument(value: string): string {
  return /^[^\s"&|<>^()]+$/u.test(value) ? value : `"${value.replaceAll('"', '\\"')}"`;
}

function vcsCommandError(error: unknown, repoRoot: string, command: string | undefined): VcsCommandError {
  return new VcsCommandError({
    command: command ?? "command",
    cwd: repoRoot,
    exitCode: commandErrorCode(error),
    signal: commandErrorSignal(error),
    stderrSummary: commandErrorSummary(error)
  });
}

function commandErrorCode(error: unknown): string | number | undefined {
  if (typeof error === "object" && error && "status" in error) {
    const status = (error as { readonly status?: unknown }).status;
    if (typeof status === "number" || typeof status === "string") return status;
  }
  if (typeof error === "object" && error && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "number" || typeof code === "string") return code;
  }
  return undefined;
}

function commandErrorSignal(error: unknown): string | undefined {
  if (typeof error === "object" && error && "signal" in error) {
    const signal = (error as { readonly signal?: unknown }).signal;
    if (typeof signal === "string" && signal.length > 0) return signal;
  }
  return undefined;
}

function commandErrorSummary(error: unknown): string | undefined {
  if (typeof error === "object" && error && "stderr" in error) {
    const stderr = (error as { readonly stderr?: unknown }).stderr;
    const text = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : typeof stderr === "string" ? stderr : "";
    const firstLine = text.trim().split(/\r?\n/u).find((line) => line.trim().length > 0);
    if (firstLine) return firstLine;
  }
  if (error instanceof Error) return error.message.split(/\r?\n/u)[0] ?? error.message;
  return String(error);
}
