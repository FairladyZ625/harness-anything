import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** G38 write-port external-wait dimension: counts only while a serialized write turn executes work. */
const writePortDepth = new AsyncLocalStorage<number>();
let networkRoundTrips = 0;
let remoteChildProcesses = 0;

const REMOTE_GIT_SUBCOMMANDS = new Set(["clone", "fetch", "ls-remote", "pull", "push"]);

export const writePortExternalObservation = Object.freeze({
  currentDepth: (): number => writePortDepth.getStore() ?? 0,
  runInWritePort<T>(work: () => T | PromiseLike<T>): T | PromiseLike<T> {
    return writePortDepth.run((writePortDepth.getStore() ?? 0) + 1, work);
  },
  noteNetworkRoundTrip: (): void => {
    if ((writePortDepth.getStore() ?? 0) > 0) networkRoundTrips += 1;
  },
  noteRemoteChildProcess: (): void => {
    if ((writePortDepth.getStore() ?? 0) > 0) remoteChildProcesses += 1;
  },
  reset: (): void => {
    networkRoundTrips = 0;
    remoteChildProcesses = 0;
  },
  snapshot: (): { readonly networkRoundTrips: number; readonly remoteChildProcesses: number } => ({
    networkRoundTrips,
    remoteChildProcesses,
  }),
});

function isLocalGitEndpoint(target: string): boolean {
  return (
    target.startsWith("file://") ||
    target.startsWith("/") ||
    target.startsWith("./") ||
    target.startsWith("../") ||
    /^[A-Za-z]:[\\/]/u.test(target)
  );
}

function isRemoteGitEndpoint(target: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/)/u.test(target);
}

function remoteUrlLooksRemote(url: string): boolean {
  return isRemoteGitEndpoint(url) && !isLocalGitEndpoint(url);
}

function resolveGitConfigPath(cwd: string): string | null {
  if (!existsSync(cwd)) return null;
  let dir = path.resolve(cwd);
  for (;;) {
    const dotGit = path.join(dir, ".git");
    if (existsSync(dotGit)) {
      const stats = statSync(dotGit);
      let gitDir: string | null = null;
      if (stats.isDirectory()) {
        gitDir = dotGit;
      } else if (stats.isFile()) {
        const match = /^gitdir:\s*(.+)$/mu.exec(readFileSync(dotGit, "utf8"));
        if (match) gitDir = path.resolve(dir, match[1].trim());
      }
      if (!gitDir) return null;
      const commonDirFile = path.join(gitDir, "commondir");
      const configDir = existsSync(commonDirFile)
        ? path.resolve(gitDir, readFileSync(commonDirFile, "utf8").trim())
        : gitDir;
      const configPath = path.join(configDir, "config");
      return existsSync(configPath) ? configPath : null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readGitRemoteUrl(cwd: string, name: string): string | null {
  const configPath = resolveGitConfigPath(cwd);
  if (!configPath) return null;
  const header = `[remote "${name}"]`;
  let inRemote = false;
  for (const rawLine of readFileSync(configPath, "utf8").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      inRemote = line === header;
      continue;
    }
    if (!inRemote) continue;
    const match = /^url\s*=\s*(.+)$/u.exec(line);
    if (match) return match[1].trim();
  }
  return null;
}

function namedRemoteLooksRemote(cwd: string | undefined, name: string): boolean {
  if (!cwd) return true;
  const url = readGitRemoteUrl(cwd, name);
  if (url === null) return true;
  return remoteUrlLooksRemote(url);
}

/** True when a child git invocation would contact a non-local endpoint. */
export function classifyRemoteGitInvocation(command: string, args: readonly string[], cwd?: string): boolean {
  const base = path.basename(command);
  if (base !== "git" && base !== "git.exe") return false;
  let index = 0;
  let workdir = cwd;
  if (args[0] === "-C") {
    workdir = args[1];
    index = 2;
  }
  const subcommand = args[index];
  if (!subcommand || !REMOTE_GIT_SUBCOMMANDS.has(subcommand)) return false;
  for (const arg of args.slice(index + 1)) {
    if (arg.startsWith("-")) continue;
    if (isLocalGitEndpoint(arg) || arg === ".") return false;
    if (isRemoteGitEndpoint(arg)) return true;
    if (arg === "origin" || arg === "upstream") return namedRemoteLooksRemote(workdir, arg);
  }
  return subcommand === "fetch" || subcommand === "push" || subcommand === "pull";
}
