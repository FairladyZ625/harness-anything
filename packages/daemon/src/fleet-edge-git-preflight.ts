import path from "node:path";
import { runProcessExitAsync } from "./process-port.ts";

export interface FleetRepositoryGitMetadata {
  readonly originUrl: string | null;
  readonly defaultBranch: string | null;
  readonly defaultBranchCommit: string | null;
}

export interface FleetEdgeGitPreflightInput {
  readonly rootDir: string;
  readonly center: {
    readonly originUrl?: string | null;
    readonly defaultBranch?: string | null;
    readonly defaultBranchCommit?: string | null;
  };
  readonly operation: "edge sync" | "runtime dispatch";
}

const gitTimeoutMs = 10_000,
  gitFetchTimeoutMs = 30_000,
  nonInteractiveGitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

export class FleetEdgeGitPreflightError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "FleetEdgeGitPreflightError";
    this.code = code;
  }
}

async function gitText(rootDir: string, args: readonly string[]): Promise<string | null> {
  const result = await runProcessExitAsync("git", [...args], rootDir, nonInteractiveGitEnv, undefined, undefined, {
    timeoutMs: gitTimeoutMs,
  }).catch(() => null);
  if (!result || result.exitCode !== 0) return null;
  const value = result.stdout.trim();
  return value || null;
}

function branchName(ref: string | null): string | null {
  if (!ref) return null;
  return ref.startsWith("origin/") ? ref.slice("origin/".length) : ref;
}

/** Canonical identity for a Git remote. Credentials and a trailing .git are never compared or printed. */
export function normalizeFleetGitRemote(value: string, rootDir?: string): string {
  const raw = value.trim();
  if (!raw) return "";
  const scp = raw.includes("://") ? null : /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/u.exec(raw);
  if (scp) return `git-remote://${scp[1]!.toLowerCase()}${normalizeRemotePath(scp[2]!)}`;
  try {
    const url = new URL(raw);
    if (url.protocol === "file:") return `git-file://${normalizeLocalPath(decodeURIComponent(url.pathname), rootDir)}`;
    return `git-remote://${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ""}${normalizeRemotePath(url.pathname)}`;
  } catch {
    return `git-file://${normalizeLocalPath(raw, rootDir)}`;
  }
}

function normalizeRemotePath(value: string): string {
  const path = value.replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, "");
  return `/${path}`;
}

function normalizeLocalPath(value: string, rootDir?: string): string {
  const resolved = path.resolve(rootDir ?? process.cwd(), value);
  return resolved
    .replace(/\\+/gu, "/")
    .replace(/\/+$/u, "")
    .replace(/\.git$/u, "");
}

/** Reads the center checkout's registered origin and the branch head it currently knows. */
export async function readFleetCenterGitMetadata(rootDir: string): Promise<FleetRepositoryGitMetadata> {
  if (!rootDir) return { originUrl: null, defaultBranch: null, defaultBranchCommit: null };
  const origin = await gitText(rootDir, ["remote", "get-url", "origin"]);
  if (!origin) return { originUrl: null, defaultBranch: null, defaultBranchCommit: null };
  const remoteHead = branchName(
      await gitText(rootDir, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]),
    ),
    checkedOut = branchName(await gitText(rootDir, ["symbolic-ref", "--quiet", "--short", "HEAD"])),
    defaultBranch = remoteHead ?? checkedOut,
    defaultBranchCommit = defaultBranch
      ? ((await gitText(rootDir, ["rev-parse", "--verify", `refs/remotes/origin/${defaultBranch}^{commit}`])) ??
        (await gitText(rootDir, ["rev-parse", "--verify", `refs/heads/${defaultBranch}^{commit}`])))
      : null;
  return {
    originUrl: normalizeFleetGitRemote(origin, rootDir),
    defaultBranch,
    defaultBranchCommit,
  };
}

/** Reads the local edge checkout's origin and its own default branch commit. */
export async function readFleetEdgeGitMetadata(rootDir: string): Promise<FleetRepositoryGitMetadata> {
  const origin = await gitText(rootDir, ["remote", "get-url", "origin"]);
  if (!origin) return { originUrl: null, defaultBranch: null, defaultBranchCommit: null };
  const remoteHead = branchName(
      await gitText(rootDir, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]),
    ),
    checkedOut = branchName(await gitText(rootDir, ["symbolic-ref", "--quiet", "--short", "HEAD"])),
    defaultBranch = remoteHead ?? checkedOut,
    defaultBranchCommit = defaultBranch
      ? ((await gitText(rootDir, ["rev-parse", "--verify", `refs/heads/${defaultBranch}^{commit}`])) ??
        (await gitText(rootDir, ["rev-parse", "--verify", `refs/remotes/origin/${defaultBranch}^{commit}`])))
      : null;
  return {
    originUrl: normalizeFleetGitRemote(origin, rootDir),
    defaultBranch,
    defaultBranchCommit,
  };
}

export async function fleetEdgeRepositoryGitFailure(
  input: FleetEdgeGitPreflightInput,
): Promise<FleetEdgeGitPreflightError | null> {
  // A center without a registered origin is a local-only development center. There is no
  // authoritative remote or head to compare against, so preserve that existing mode; once the
  // center exposes an origin, all edge dispatches become fail-closed on this contract.
  if (!input.center.originUrl) return null;
  const local = await readFleetEdgeGitMetadata(input.rootDir),
    operation = input.operation;
  if (!local.originUrl)
    return new FleetEdgeGitPreflightError(
      "edge_origin_missing",
      `Cannot start ${operation}: ${input.rootDir} has no Git origin remote. Add origin pointing to the center repository, then retry; Harness will not change remotes automatically.`,
    );
  if (local.originUrl !== input.center.originUrl)
    return new FleetEdgeGitPreflightError(
      "edge_origin_mismatch",
      `Cannot start ${operation}: the edge origin does not match the center repository origin. Set it with ` +
        `git -C ${input.rootDir} remote set-url origin <center-origin>, then retry; Harness will not change remotes automatically.`,
    );
  if (!input.center.defaultBranch || !input.center.defaultBranchCommit)
    return new FleetEdgeGitPreflightError(
      "center_default_branch_unavailable",
      `Cannot start ${operation}: the center has no known default branch head. Update the center checkout and retry.`,
    );
  if (local.defaultBranch !== input.center.defaultBranch)
    return new FleetEdgeGitPreflightError(
      "edge_default_branch_mismatch",
      `Cannot start ${operation}: the edge default branch is ${local.defaultBranch ?? "unknown"}, while the center uses ${input.center.defaultBranch}. Check out the center default branch and retry.`,
    );
  const fetched = await runProcessExitAsync(
    "git",
    [
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      "origin",
      `+refs/heads/${input.center.defaultBranch}:refs/remotes/origin/${input.center.defaultBranch}`,
    ],
    input.rootDir,
    nonInteractiveGitEnv,
    undefined,
    undefined,
    { timeoutMs: gitFetchTimeoutMs },
  ).catch(() => null);
  if (!fetched || fetched.exitCode !== 0)
    return new FleetEdgeGitPreflightError(
      "edge_default_branch_unverifiable",
      `Cannot start ${operation}: the edge could not fetch ${input.center.defaultBranch} from the matching origin. Run git -C ${input.rootDir} fetch origin ${input.center.defaultBranch}, then retry.`,
    );
  if (!local.defaultBranchCommit)
    return new FleetEdgeGitPreflightError(
      "edge_default_branch_unavailable",
      `Cannot start ${operation}: the edge default branch has no commit. Fetch ${input.center.defaultBranch} from origin, then retry.`,
    );
  const relation = await runProcessExitAsync(
    "git",
    ["rev-list", "--left-right", "--count", `${local.defaultBranchCommit}...${input.center.defaultBranchCommit}`],
    input.rootDir,
    nonInteractiveGitEnv,
    undefined,
    undefined,
    { timeoutMs: gitTimeoutMs },
  ).catch(() => null);
  if (!relation || relation.exitCode !== 0)
    return new FleetEdgeGitPreflightError(
      "edge_default_branch_unverifiable",
      `Cannot start ${operation}: the edge does not contain the center default branch head ${input.center.defaultBranchCommit}. Fetch ${input.center.defaultBranch} from the matching origin, then retry.`,
    );
  const [localOnly, centerOnly] = relation.stdout.trim().split(/\s+/u).map(Number);
  if (localOnly > 0 && centerOnly > 0)
    return new FleetEdgeGitPreflightError(
      "edge_default_branch_diverged",
      `Cannot start ${operation}: the edge default branch diverges from the center ${input.center.defaultBranch}. Rebase or reset it explicitly onto the center head, then retry.`,
    );
  if (centerOnly > 0)
    return new FleetEdgeGitPreflightError(
      "edge_default_branch_behind",
      `Cannot start ${operation}: the edge default branch is behind the center ${input.center.defaultBranch} by ${centerOnly} commit${centerOnly === 1 ? "" : "s"}. Run git -C ${input.rootDir} fetch origin ${input.center.defaultBranch} && git -C ${input.rootDir} merge --ff-only origin/${input.center.defaultBranch}, then retry.`,
    );
  return null;
}

export async function assertFleetEdgeRepositoryGit(input: FleetEdgeGitPreflightInput): Promise<void> {
  const failure = await fleetEdgeRepositoryGitFailure(input);
  if (failure) throw failure;
}
