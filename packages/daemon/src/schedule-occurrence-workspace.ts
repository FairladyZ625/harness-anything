import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
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
  execFileSync("git", ["-C", rootDir, "worktree", "add", cwd, "-b", branch, "origin/main"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return { rootDir, cwd, runtime: { ...base, worktree: { cwd, branch, baseRef: "origin/main" } } };
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
    execFileSync("git", ["-C", rootDir, "worktree", "remove", worktree.cwd], {
      encoding: "utf8",
      windowsHide: true,
    });
    execFileSync("git", ["-C", rootDir, "branch", "-D", worktree.branch], {
      encoding: "utf8",
      windowsHide: true,
    });
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
  return [detail, retained].filter(Boolean).join(" ") || null;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true }).trim();
}
