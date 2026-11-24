import { AsyncLocalStorage } from "node:async_hooks";
import { lstat, readFile, readdir } from "node:fs/promises";
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
    /^file:\/\//iu.test(target) ||
    /^[\\/]/u.test(target) ||
    /^\.{1,2}[\\/]/u.test(target) ||
    /^[A-Za-z]:[\\/]/u.test(target)
  );
}

function isRemoteGitEndpoint(target: string): boolean {
  return /^(?:[\w+.-]+:\/\/|[\w+.-]+::|[^\\/]+:)/u.test(target);
}

function remoteUrlLooksRemote(url: string): boolean {
  return isRemoteGitEndpoint(url) && !isLocalGitEndpoint(url);
}

async function resolveGitConfigPath(cwd: string): Promise<string | null> {
  let dir = path.resolve(cwd);
  for (;;) {
    const dotGit = path.join(dir, ".git");
    const directoryEntries = await readdir(dir);
    if (directoryEntries.includes(".git")) {
      const gitStats = await lstat(dotGit);
      let gitDir: string | null = null;
      if (gitStats.isDirectory()) {
        gitDir = dotGit;
      } else if (gitStats.isFile()) {
        const match = /^gitdir:\s*(.+)$/mu.exec(await readFile(dotGit, "utf8"));
        if (!match) throw new Error("Git worktree .git file has no gitdir path");
        gitDir = path.resolve(dir, match[1].trim());
      }
      if (gitDir === null) return null;
      const commonDirEntries = await readdir(gitDir);
      const commonDirFile = path.join(gitDir, "commondir");
      const configDir = commonDirEntries.includes("commondir")
        ? path.resolve(gitDir, (await readFile(commonDirFile, "utf8")).trim())
        : gitDir;
      const configEntries = await readdir(configDir);
      return configEntries.includes("config") ? path.join(configDir, "config") : null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function readGitRemoteUrl(cwd: string, name: string): Promise<string | null> {
  const configPath = await resolveGitConfigPath(cwd);
  if (!configPath) return null;
  const header = `[remote "${name}"]`;
  let inRemote = false;
  for (const rawLine of (await readFile(configPath, "utf8")).split(/\r?\n/u)) {
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

async function namedRemoteLooksRemote(cwd: string | undefined, name: string): Promise<boolean> {
  if (!cwd) return true;
  const url = await readGitRemoteUrl(cwd, name);
  if (url === null) return true;
  return remoteUrlLooksRemote(url);
}

/** True when a child git invocation would contact a non-local endpoint. */
export async function classifyRemoteGitInvocation(
  command: string,
  args: readonly string[],
  cwd?: string,
): Promise<boolean> {
  const base = path.basename(command);
  if (base.toLowerCase() !== "git" && base.toLowerCase() !== "git.exe") return false;
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
    if (arg === "origin" || arg === "upstream") return await namedRemoteLooksRemote(workdir, arg);
  }
  return subcommand === "fetch" || subcommand === "push" || subcommand === "pull";
}
