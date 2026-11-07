import path from "node:path";
import { runProcessExitAsync } from "./process-port.ts";

export interface FleetRepositoryGitMetadata {
  readonly originUrl: string | null;
  /** Copyable center origin for join guidance; credentials are removed before it crosses the wire. */
  readonly originAddress?: string | null;
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

export function isSupportedFleetGitRemote(value: string): boolean {
  const raw = value.trim();
  if (!raw || raw.length > 2_048 || /[\0\r\n]/u.test(raw) || raw.includes("::")) return false;
  if (path.isAbsolute(raw)) return true;
  const scp = raw.includes("://") ? null : /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/u.exec(raw);
  if (scp) return true;
  try {
    const url = new URL(raw);
    return (
      ["file:", "git:", "http:", "https:", "ssh:"].includes(url.protocol) &&
      (url.protocol === "file:" || url.hostname !== "")
    );
  } catch {
    return false;
  }
}

function fleetGitRemoteAddressForDisplay(value: string): string | null {
  const raw = value.trim();
  if (!isSupportedFleetGitRemote(raw)) return null;
  if (path.isAbsolute(raw)) return raw;
  if (!raw.includes("://")) {
    const scp = /^(?:([^@/:\s]+)(?::[^@/\s]*)?@)?([^:/\s]+):(.+)$/u.exec(raw);
    if (scp) return `${scp[1] ? `${scp[1]}@` : ""}${scp[2]}:${scp[3]}`;
    return raw;
  }
  const url = new URL(raw);
  url.password = "";
  if (url.protocol !== "ssh:") url.username = "";
  return url.toString();
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
export async function readFleetCenterGitMetadata(rootDir: string, enabled = true): Promise<FleetRepositoryGitMetadata> {
  if (!enabled) return { originUrl: null, originPushUrls: [], defaultBranch: null, defaultBranchCommit: null };
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
      originAddress: fleetGitRemoteAddressForDisplay(origin),
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
  const operation = input.operation,
    center = input.center;
  if (
    center.originUrl === undefined ||
    center.originPushUrls === undefined ||
    center.defaultBranch === undefined ||
    center.defaultBranchCommit === undefined
  )
    return new FleetEdgeGitPreflightError(
      "center_git_metadata_unavailable",
      `Cannot start ${operation}: the center did not provide complete Git repository metadata. Repair the center Git configuration, then retry.`,
    );
  if (!center.originUrl) {
    if (center.originPushUrls.length === 0 && center.defaultBranch === null && center.defaultBranchCommit === null)
      return null;
    return new FleetEdgeGitPreflightError(
      "center_git_metadata_unavailable",
      `Cannot start ${operation}: the center's Git publish metadata is incomplete. Repair the center repository Git configuration, then retry.`,
    );
  }
  if (center.originPushUrls.length === 0)
    return new FleetEdgeGitPreflightError(
      "center_git_metadata_unavailable",
      `Cannot start ${operation}: the center did not provide a Git publish destination. Repair the center Git configuration, then retry.`,
    );
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
  if (local.originPushUrls.length === 0)
    return new FleetEdgeGitPreflightError(
      "edge_push_url_mismatch",
      `Cannot start ${operation}: the edge origin has no effective push destination. Configure one, then retry; Harness will not change remotes automatically.`,
    );
  if (!center.defaultBranch || !center.defaultBranchCommit)
    return new FleetEdgeGitPreflightError(
      "center_default_branch_unavailable",
      `Cannot start ${operation}: the center has no known default branch head. Update the center checkout and retry.`,
    );
  if (local.defaultBranch !== center.defaultBranch)
    return new FleetEdgeGitPreflightError(
      "edge_default_branch_mismatch",
      `Cannot start ${operation}: the edge default branch is ${local.defaultBranch ?? "unknown"}, while the center uses ${center.defaultBranch}. Check out the center default branch and retry.`,
    );
  const configuredOrigin = await gitText(input.rootDir, ["remote", "get-url", "origin"]);
  if (!configuredOrigin || !isSupportedFleetGitRemote(configuredOrigin))
    return new FleetEdgeGitPreflightError(
      "edge_origin_mismatch",
      `Cannot start ${operation}: the edge origin uses an unsupported Git transport. Point origin at a repository with the center history, then retry; Harness will not change remotes automatically.`,
    );
  const fetched = await runProcessExitAsync(
    "git",
    [
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      "origin",
      `+refs/heads/${center.defaultBranch}:refs/remotes/origin/${center.defaultBranch}`,
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
      `Cannot start ${operation}: the edge could not fetch ${center.defaultBranch} from the matching origin. Run git -C ${input.rootDir} fetch origin ${center.defaultBranch}, then retry.`,
    );
  const remoteHead = await gitText(
      input.rootDir,
      ["rev-parse", "--verify", `refs/remotes/origin/${center.defaultBranch}^{commit}`],
      true,
    ),
    originContainsCenter = remoteHead
      ? await runProcessExitAsync(
          "git",
          ["merge-base", "--is-ancestor", center.defaultBranchCommit, remoteHead],
          input.rootDir,
          nonInteractiveGitEnv,
          undefined,
          undefined,
          { timeoutMs: gitTimeoutMs },
        ).catch(() => null)
      : null;
  if (!originContainsCenter || originContainsCenter.exitCode !== 0)
    return new FleetEdgeGitPreflightError(
      "edge_origin_mismatch",
      `Cannot start ${operation}: the edge origin's ${center.defaultBranch} default branch history does not contain the center head ${center.defaultBranchCommit}. Point origin at a repository with that history, then retry; Harness will not change remotes automatically.`,
    );
  const pushTargets = await gitText(input.rootDir, ["remote", "get-url", "--push", "--all", "origin"]);
  for (const target of (pushTargets ?? "").split(/\r?\n/u).filter(Boolean)) {
    if (!isSupportedFleetGitRemote(target))
      return new FleetEdgeGitPreflightError(
        "edge_push_url_mismatch",
        `Cannot start ${operation}: an edge origin push destination uses an unsupported Git transport. Configure an HTTPS, SSH, Git, or local repository address, then retry.`,
      );
    const fetchedTarget = await runProcessExitAsync(
      "git",
      ["fetch", "--quiet", "--no-tags", target, `+refs/heads/${center.defaultBranch}`],
      input.rootDir,
      nonInteractiveGitEnv,
      undefined,
      undefined,
      { timeoutMs: gitFetchTimeoutMs },
    ).catch(() => null);
    const targetHead =
      fetchedTarget?.exitCode === 0
        ? await gitText(input.rootDir, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"], true)
        : null;
    const targetContainsCenter = targetHead
      ? await runProcessExitAsync(
          "git",
          ["merge-base", "--is-ancestor", center.defaultBranchCommit, targetHead],
          input.rootDir,
          nonInteractiveGitEnv,
          undefined,
          undefined,
          { timeoutMs: gitTimeoutMs },
        ).catch(() => null)
      : null;
    if (!targetContainsCenter || targetContainsCenter.exitCode !== 0)
      return new FleetEdgeGitPreflightError(
        "edge_push_url_mismatch",
        `Cannot start ${operation}: an edge origin push destination does not contain the center ${center.defaultBranch} history. Point the push destination at the same repository history, then retry; Harness will not change remotes automatically.`,
      );
  }
  if (!local.defaultBranchCommit)
    return new FleetEdgeGitPreflightError(
      "edge_default_branch_unavailable",
      `Cannot start ${operation}: the edge default branch has no commit. Fetch ${center.defaultBranch} from origin, then retry.`,
    );
  const relation = await runProcessExitAsync(
    "git",
    ["rev-list", "--left-right", "--count", `${local.defaultBranchCommit}...${center.defaultBranchCommit}`],
    input.rootDir,
    nonInteractiveGitEnv,
    undefined,
    undefined,
    { timeoutMs: gitTimeoutMs },
  ).catch(() => null);
  if (!relation || relation.exitCode !== 0)
    return new FleetEdgeGitPreflightError(
      "edge_origin_mismatch",
      `Cannot start ${operation}: the edge origin's ${center.defaultBranch} history does not contain the center default branch head ${center.defaultBranchCommit}. Point origin at a repository with that history, then retry; Harness will not change remotes automatically.`,
    );
  const [localOnly, centerOnly] = relation.stdout.trim().split(/\s+/u).map(Number);
  if (localOnly > 0 && centerOnly > 0)
    return new FleetEdgeGitPreflightError(
      "edge_default_branch_diverged",
      `Cannot start ${operation}: the edge default branch diverges from the center ${center.defaultBranch}. Rebase or reset it explicitly onto the center head, then retry.`,
    );
  if (centerOnly > 0)
    return new FleetEdgeGitPreflightError(
      "edge_default_branch_behind",
      `Cannot start ${operation}: the edge default branch is behind the center ${center.defaultBranch} by ${centerOnly} commit${centerOnly === 1 ? "" : "s"}. Run git -C ${input.rootDir} fetch origin ${center.defaultBranch} && git -C ${input.rootDir} merge --ff-only origin/${center.defaultBranch}, then retry.`,
    );
  return null;
}

export async function assertFleetEdgeRepositoryGit(input: FleetEdgeGitPreflightInput): Promise<void> {
  const failure = await fleetEdgeRepositoryGitFailure(input);
  if (failure) throw failure;
}
