import path from "node:path";
import { runProcessExitAsync } from "./process-port.ts";

export interface FleetRepositoryGitMetadata {
  readonly originUrl: string | null;
  readonly originPushUrls: readonly string[];
  readonly defaultBranch: string | null;
  readonly defaultBranchCommit: string | null;
}

export interface FleetEdgeGitPreflightInput {
  readonly rootDir: string;
  readonly center: {
    readonly originUrl?: string | null;
    readonly originPushUrls?: readonly string[];
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

async function gitText(rootDir: string, args: readonly string[], allowNonzero = false): Promise<string | null> {
  const result = await runProcessExitAsync("git", [...args], rootDir, nonInteractiveGitEnv, undefined, undefined, {
    timeoutMs: gitTimeoutMs,
  });
  if (result.exitCode !== 0) {
    if (allowNonzero) return null;
    throw new Error(`git ${args.join(" ")} exited ${result.exitCode}: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
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
  try {
    if (!rootDir) throw new Error("registered center repository root is unavailable");
    await gitText(rootDir, ["rev-parse", "--show-toplevel"]);
    const remotes = await gitText(rootDir, ["remote"]);
    if (!remotes) return { originUrl: null, originPushUrls: [], defaultBranch: null, defaultBranchCommit: null };
    if (!remotes.split(/\s+/u).includes("origin")) throw new Error("configured Git remotes do not include origin");
    const origin = await gitText(rootDir, ["remote", "get-url", "origin"]);
    if (!origin) throw new Error("origin has no fetch URL");
    const pushUrlText = await gitText(rootDir, ["remote", "get-url", "--push", "--all", "origin"]);
    if (!pushUrlText) throw new Error("origin has no effective push URL");
    const pushUrls = pushUrlText
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((value) => normalizeFleetGitRemote(value, rootDir));
    if (pushUrls.length === 0) throw new Error("origin has no effective push URL");
    const remoteHead = branchName(
        await gitText(rootDir, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], true),
      ),
      checkedOut = branchName(await gitText(rootDir, ["symbolic-ref", "--quiet", "--short", "HEAD"], true)),
      defaultBranch = remoteHead ?? checkedOut;
    if (!defaultBranch) throw new Error("default branch cannot be resolved");
    const defaultBranchCommit =
      (await gitText(rootDir, ["rev-parse", "--verify", `refs/remotes/origin/${defaultBranch}^{commit}`], true)) ??
      (await gitText(rootDir, ["rev-parse", "--verify", `refs/heads/${defaultBranch}^{commit}`], true));
    if (!defaultBranchCommit) throw new Error(`default branch ${defaultBranch} has no readable commit`);
    return {
      originUrl: normalizeFleetGitRemote(origin, rootDir),
      originPushUrls: pushUrls,
      defaultBranch,
      defaultBranchCommit,
    };
  } catch (error) {
    if (error instanceof FleetEdgeGitPreflightError) throw error;
    throw new FleetEdgeGitPreflightError(
      "center_git_metadata_unavailable",
      `Cannot verify the center repository Git configuration${rootDir ? ` at ${rootDir}` : ""}: ${error instanceof Error ? error.message : String(error)}. Repair the center repository Git metadata before joining or dispatching edge work.`,
    );
  }
}

/** Reads the local edge checkout's origin and its own default branch commit. */
export async function readFleetEdgeGitMetadata(rootDir: string): Promise<FleetRepositoryGitMetadata> {
  await gitText(rootDir, ["rev-parse", "--show-toplevel"]);
  const remotes = await gitText(rootDir, ["remote"]);
  if (!remotes || !remotes.split(/\s+/u).includes("origin"))
    return { originUrl: null, originPushUrls: [], defaultBranch: null, defaultBranchCommit: null };
  const origin = await gitText(rootDir, ["remote", "get-url", "origin"]);
  if (!origin) return { originUrl: null, originPushUrls: [], defaultBranch: null, defaultBranchCommit: null };
  const pushUrlText = await gitText(rootDir, ["remote", "get-url", "--push", "--all", "origin"]);
  if (!pushUrlText) throw new Error(`origin at ${rootDir} has no effective push URL`);
  const pushUrls = pushUrlText
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((value) => normalizeFleetGitRemote(value, rootDir)),
    remoteHead = branchName(
      await gitText(rootDir, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], true),
    ),
    checkedOut = branchName(await gitText(rootDir, ["symbolic-ref", "--quiet", "--short", "HEAD"], true)),
    defaultBranch = remoteHead ?? checkedOut,
    defaultBranchCommit = defaultBranch
      ? ((await gitText(rootDir, ["rev-parse", "--verify", `refs/heads/${defaultBranch}^{commit}`], true)) ??
        (await gitText(rootDir, ["rev-parse", "--verify", `refs/remotes/origin/${defaultBranch}^{commit}`], true)))
      : null;
  return {
    originUrl: normalizeFleetGitRemote(origin, rootDir),
    originPushUrls: pushUrls,
    defaultBranch,
    defaultBranchCommit,
  };
}

export async function fleetEdgeRepositoryGitFailure(
  input: FleetEdgeGitPreflightInput,
): Promise<FleetEdgeGitPreflightError | null> {
  const operation = input.operation;
  if (!input.center.originPushUrls)
    return new FleetEdgeGitPreflightError(
      "center_git_metadata_unavailable",
      `Cannot start ${operation}: the center did not provide complete Git publish metadata. Refresh edge registration or repair the center Git configuration, then retry.`,
    );
  if (!input.center.originUrl) {
    if (input.center.originPushUrls.length === 0) return null;
    return new FleetEdgeGitPreflightError(
      "center_git_metadata_unavailable",
      `Cannot start ${operation}: the center's Git publish metadata is incomplete. Repair the center repository Git configuration, then retry.`,
    );
  }
  let local: FleetRepositoryGitMetadata;
  try {
    local = await readFleetEdgeGitMetadata(input.rootDir);
  } catch (error) {
    return new FleetEdgeGitPreflightError(
      "edge_git_metadata_unavailable",
      `Cannot start ${operation}: Git metadata at ${input.rootDir} cannot be read: ${error instanceof Error ? error.message : String(error)}. Repair the edge checkout and retry.`,
    );
  }
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
  if (local.originPushUrls.length === 0 || !sameUrls(local.originPushUrls, input.center.originPushUrls))
    return new FleetEdgeGitPreflightError(
      "edge_push_url_mismatch",
      `Cannot start ${operation}: the edge's effective origin push URL${local.originPushUrls.length === 1 ? "" : "s"} do not match the center's publish destination. Run git -C ${input.rootDir} remote set-url --push origin <center-push-url>, then retry; Harness will not change remotes automatically.`,
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

function sameUrls(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort(),
    b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export async function assertFleetEdgeRepositoryGit(input: FleetEdgeGitPreflightInput): Promise<void> {
  const failure = await fleetEdgeRepositoryGitFailure(input);
  if (failure) throw failure;
}
