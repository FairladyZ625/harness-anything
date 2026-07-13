import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import { resolveHarnessLayout, type CurrentSessionRef } from "../../../../kernel/src/index.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliErrorCode as CliErrorCodeValue } from "../../cli/error-codes.ts";
import { gitTopLevel } from "./authored-git.ts";

type WorktreeAction = Extract<Parameters<CommandRunner>[1]["action"], { readonly kind: "worktree-create" | "worktree-status" }>;

interface WorktreeBinding {
  readonly schema: "task-worktree-binding/v1";
  readonly taskId: string;
  readonly slug: string;
  readonly agentNamespace: string;
  readonly branchPrefix: string;
  readonly branchName: string;
  readonly worktreePath: string;
  readonly baseRef: string;
  readonly baseCommit: string;
  readonly createdAt: string;
  readonly createdByRuntime: string;
  readonly status: "active";
}

export const runWorktreeCommand: CommandRunner = (context, command) => {
  const action = command.action as WorktreeAction;
  return context.currentSessionProbe.currentSession.pipe(
    Effect.map((session) => action.kind === "worktree-create"
      ? createWorktree(context.rootDir, action, session)
      : statusWorktree(context.rootDir, action))
  );
};

function createWorktree(rootDir: string, action: Extract<WorktreeAction, { readonly kind: "worktree-create" }>, session: CurrentSessionRef) {
  try {
    const root = gitTopLevel(rootDir);
    if (!root) return worktreeFailure(action.kind, "Current directory is not inside a Git worktree.", CliErrorCode.WorktreeCommandFailed, action.taskId);
    const layout = resolveHarnessLayout(root);
    const slug = taskSlug(layout.taskPackagePath(action.taskId), action.taskId);
    const namespace = resolveNamespace(action, session);
    if (!namespace.ok) return worktreeFailure(action.kind, namespace.message, CliErrorCode.InvalidWorktreeNamespace, action.taskId);
    const baseRef = action.baseRef ?? "origin/main";
    fetchRemoteIfNeeded(root, baseRef);
    const baseCommit = git(root, ["rev-parse", "--verify", `${baseRef}^{commit}`]).trim();
    const branchName = `${namespace.value}/${slug}`;
    if (gitBranchExists(root, branchName)) {
      return worktreeFailure(action.kind, `Branch already exists: ${branchName}`, CliErrorCode.WorktreeCommandFailed, action.taskId);
    }
    const worktreePath = path.resolve(root, action.worktreePath ?? path.join(".worktrees", slug));
    if (existsSync(worktreePath) && readdirSync(worktreePath).length > 0) {
      return worktreeFailure(action.kind, `Worktree path is not empty: ${displayPath(root, worktreePath)}`, CliErrorCode.WorktreeCommandFailed, action.taskId);
    }
    const rootDirty = git(root, ["status", "--porcelain"]).trim();
    if (rootDirty.length > 0) {
      return worktreeFailure(action.kind, "Shared root has uncommitted changes; create the task worktree from a clean root.", CliErrorCode.WorktreeCommandFailed, action.taskId);
    }

    git(root, ["worktree", "add", worktreePath, "-b", branchName, baseRef]);
    const binding: WorktreeBinding = {
      schema: "task-worktree-binding/v1",
      taskId: action.taskId,
      slug,
      agentNamespace: namespace.value,
      branchPrefix: namespace.value,
      branchName,
      worktreePath,
      baseRef,
      baseCommit,
      createdAt: new Date().toISOString(),
      createdByRuntime: session.runtime,
      status: "active"
    };
    const bindingPath = writeBinding(layout.generatedRoot, binding);
    const report = statusReport(root, binding, bindingPath);
    return {
      ok: true,
      command: action.kind,
      taskId: action.taskId,
      path: displayPath(root, worktreePath),
      report
    };
  } catch (error) {
    return worktreeFailure(action.kind, errorMessage(error), CliErrorCode.WorktreeCommandFailed, action.taskId);
  }
}

function statusWorktree(rootDir: string, action: Extract<WorktreeAction, { readonly kind: "worktree-status" }>) {
  const root = gitTopLevel(rootDir);
  if (!root) return worktreeFailure(action.kind, "Current directory is not inside a Git worktree.", CliErrorCode.WorktreeCommandFailed, action.taskId);
  const layout = resolveHarnessLayout(root);
  const bindingPath = bindingFilePath(layout.generatedRoot, action.taskId);
  if (!existsSync(bindingPath)) {
    return {
      ok: false,
      command: action.kind,
      taskId: action.taskId,
      report: {
        schema: "task-worktree-status/v1",
        taskId: action.taskId,
        status: "missing",
        blockers: [`Run ha worktree create --task ${action.taskId} --agent <agent>.`]
      },
      error: cliError(CliErrorCode.WorktreeBindingMissing, `No worktree binding found for ${action.taskId}.`)
    };
  }
  try {
    const binding = JSON.parse(readFileSync(bindingPath, "utf8")) as WorktreeBinding;
    const report = statusReport(root, binding, bindingPath);
    return {
      ok: true,
      command: action.kind,
      taskId: action.taskId,
      path: displayPath(root, binding.worktreePath),
      report
    };
  } catch (error) {
    return worktreeFailure(action.kind, errorMessage(error), CliErrorCode.WorktreeCommandFailed, action.taskId);
  }
}

function statusReport(root: string, binding: WorktreeBinding, bindingPath: string) {
  const blockers: string[] = [];
  let currentBranch: string | null = null;
  let dirty = false;
  let baseDrifted = false;
  const exists = existsSync(binding.worktreePath);
  if (!exists) {
    blockers.push("Bound worktree path is missing.");
  } else {
    currentBranch = git(binding.worktreePath, ["branch", "--show-current"]).trim() || null;
    dirty = git(binding.worktreePath, ["status", "--porcelain"]).trim().length > 0;
    if (currentBranch !== binding.branchName) blockers.push(`Expected branch ${binding.branchName}, found ${currentBranch ?? "unknown"}.`);
    if (dirty) blockers.push("Bound worktree has uncommitted changes.");
  }
  try {
    const latestBase = git(root, ["rev-parse", "--verify", `${binding.baseRef}^{commit}`]).trim();
    baseDrifted = latestBase !== binding.baseCommit;
    if (baseDrifted) blockers.push(`Base ${binding.baseRef} moved from ${binding.baseCommit.slice(0, 12)} to ${latestBase.slice(0, 12)}.`);
  } catch {
    blockers.push(`Base ref is no longer resolvable: ${binding.baseRef}.`);
  }
  const status = !exists ? "missing"
    : dirty ? "dirty"
      : baseDrifted ? "base-drifted"
        : blockers.length > 0 ? "blocked"
          : "active";
  return {
    schema: "task-worktree-status/v1",
    taskId: binding.taskId,
    status,
    branchName: binding.branchName,
    currentBranch,
    worktreePath: displayPath(root, binding.worktreePath),
    bindingPath: displayPath(root, bindingPath),
    baseRef: binding.baseRef,
    baseCommit: binding.baseCommit,
    dirty,
    baseDrifted,
    cwdMatchesWorktree: sameRealPath(process.cwd(), binding.worktreePath),
    blockers
  };
}

function resolveNamespace(action: Extract<WorktreeAction, { readonly kind: "worktree-create" }>, session: CurrentSessionRef): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly message: string } {
  const candidate = action.agent ?? action.branchPrefix ?? (session.source === "runtime" ? session.runtime : undefined);
  if (!candidate) return { ok: false, message: "Provide --agent or --branch-prefix; no runtime agent namespace was detected." };
  const normalized = candidate.replace(/\/+$/u, "");
  if (!/^[a-z][a-z0-9._-]{0,39}$/u.test(normalized)) {
    return { ok: false, message: `Invalid worktree branch namespace: ${candidate}` };
  }
  return { ok: true, value: normalized };
}

function taskSlug(packagePath: string, taskId: string): string {
  const basename = path.basename(packagePath);
  if (basename.startsWith(`${taskId}-`)) return basename.slice(taskId.length + 1);
  return taskId.replace(/^task_/u, "").toLowerCase();
}

function writeBinding(generatedRoot: string, binding: WorktreeBinding): string {
  const target = bindingFilePath(generatedRoot, binding.taskId);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(binding, null, 2)}\n`, "utf8");
  return target;
}

function bindingFilePath(generatedRoot: string, taskId: string): string {
  return path.join(generatedRoot, "worktree-bindings", `${taskId}.json`);
}

function fetchRemoteIfNeeded(root: string, baseRef: string): void {
  const remote = baseRef.split("/")[0];
  if (!remote || !baseRef.includes("/")) return;
  const remotes = git(root, ["remote"]).split(/\r?\n/u).filter(Boolean);
  if (remotes.includes(remote)) git(root, ["fetch", remote]);
}

function gitBranchExists(root: string, branchName: string): boolean {
  try {
    git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]);
    return true;
  } catch {
    return false;
  }
}

function git(cwd: string, args: ReadonlyArray<string>): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}

function worktreeFailure(command: string, message: string, code: CliErrorCodeValue, taskId: string) {
  return {
    ok: false,
    command,
    taskId,
    error: cliError(code, message)
  };
}

function displayPath(root: string, target: string): string {
  const relative = path.relative(root, target).split(path.sep).join("/");
  return relative.startsWith("..") ? target : relative || ".";
}

function sameRealPath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
