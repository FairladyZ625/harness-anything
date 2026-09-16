import { /* @gate-identity check-sync-subprocess/sync-subprocess-018 */ execFileSync } from "node:child_process";
import { existsSync, symlinkSync } from "node:fs";
import path from "node:path";
import type { ScheduleV1 } from "../../kernel/src/index.ts";
import type { TrustedScheduleRuntime } from "./runtime-spawn-types.ts";

export interface ScheduleOccurrenceWorkspace {
  readonly rootDir: string;
  readonly cwd: string;
  readonly runtime: TrustedScheduleRuntime;
}

export function prepareScheduleOccurrenceWorkspace(rootDir: string, schedule: ScheduleV1): ScheduleOccurrenceWorkspace {
  const active = schedule.status.activeRun;
  if (!active) throw new Error(`Schedule ${schedule.scheduleId} has no claimed occurrence workspace.`);
  const base = {
    scheduleId: schedule.scheduleId,
    occurrenceId: active.occurrenceId,
    claimFence: active.claimFence,
    mode: schedule.mode,
  } as const;
  if (schedule.mode === "detect") return { rootDir, cwd: rootDir, runtime: base };

  const branch = `occ-${active.occurrenceId}`,
    cwd = path.join(rootDir, ".worktrees", branch);
  /* @gate-identity check-sync-subprocess/sync-subprocess-019 */ execFileSync(
    "git",
    ["-C", rootDir, "worktree", "add", cwd, "-b", branch, "origin/main"],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  );
  const note = linkSharedNodeModules(rootDir, cwd);
  return {
    rootDir,
    cwd,
    runtime: { ...base, worktree: { cwd, branch, baseRef: "origin/main", ...(note ? { note } : {}) } },
  };
}

// npm workspaces hoist every package's dependencies to the repository root store, so one
// junction gives the fresh worktree the whole dependency surface without an install. This is
// best-effort: a repo without node_modules (non-node) or a filesystem that refuses the link
// must not fail the occurrence — the note lands on the worktree record and surfaces in the
// settlement detail instead of being swallowed.
export function linkSharedNodeModules(rootDir: string, worktreeDir: string): string | null {
  try {
    const target = path.join(rootDir, "node_modules");
    if (!existsSync(target) || existsSync(path.join(worktreeDir, "node_modules"))) return null;
    symlinkSync(target, path.join(worktreeDir, "node_modules"), "junction");
    return null;
  } catch (error) {
    return `Occurrence worktree has no linked node_modules (${
      error instanceof Error ? error.message : String(error)
    }).`;
  }
}

export function settleScheduleOccurrenceWorkspace(
  rootDir: string,
  schedule: TrustedScheduleRuntime,
): { readonly retainedDetail: string | null } {
  const worktree = schedule.worktree;
  if (!worktree) return { retainedDetail: null };
  if (!existsSync(worktree.cwd)) return { retainedDetail: null };
  try {
    const dirty = git(worktree.cwd, "status", "--porcelain").length > 0,
      commits = Number(git(worktree.cwd, "rev-list", "--count", `${worktree.baseRef}..HEAD`));
    if (dirty || commits > 0)
      return {
        retainedDetail: `Occurrence worktree retained at ${worktree.cwd} (${[
          dirty ? "uncommitted changes" : null,
          commits > 0 ? `${commits} commit${commits === 1 ? "" : "s"}` : null,
        ]
          .filter(Boolean)
          .join(", ")}).`,
      };
    /* @gate-identity check-sync-subprocess/sync-subprocess-020 */ execFileSync(
      "git",
      ["-C", rootDir, "worktree", "remove", worktree.cwd],
      {
        encoding: "utf8",
        windowsHide: true,
      },
    );
    /* @gate-identity check-sync-subprocess/sync-subprocess-021 */ execFileSync(
      "git",
      ["-C", rootDir, "branch", "-D", worktree.branch],
      {
        encoding: "utf8",
        windowsHide: true,
      },
    );
    return { retainedDetail: null };
  } catch (error) {
    return {
      retainedDetail: `Occurrence worktree retained at ${worktree.cwd} (cleanup failed: ${
        error instanceof Error ? error.message : String(error)
      }).`,
    };
  }
}

export function scheduleSettlementDetail(
  rootDir: string,
  schedule: TrustedScheduleRuntime,
  detail: string | null,
): string | null {
  const retained = settleScheduleOccurrenceWorkspace(rootDir, schedule).retainedDetail;
  return [schedule.worktree?.note, detail, retained].filter(Boolean).join(" ") || null;
}

function git(cwd: string, ...args: string[]): string {
  return /* @gate-identity check-sync-subprocess/sync-subprocess-022 */ execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}
