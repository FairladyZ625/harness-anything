import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
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

function namedRemoteLooksRemote(cwd: string | undefined, name: string): boolean {
  if (!cwd) return true;
  const result = spawnSync("git", ["remote", "get-url", name], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return true;
  return remoteUrlLooksRemote((result.stdout ?? "").trim());
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
