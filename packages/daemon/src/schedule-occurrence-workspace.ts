import { existsSync, mkdirSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync } from "node:fs";
import path from "node:path";
import type { ScheduleV1 } from "@harness-anything/kernel";
import { runProcessTextAsync } from "./process-port.ts";
import type { TrustedScheduleRuntime } from "./runtime-spawn-types.ts";

/**
 * A git worktree Harness creates and reclaims itself — schedule occurrences, task checkouts and squad
 * workers all go through these two functions, so every managed worktree ends by the same rule.
 */
export interface ManagedWorktree {
  readonly cwd: string;
  readonly branch: string;
  /** Where a new branch starts, and what "already upstream" is judged against at reclaim. */
  readonly baseRef: string;
}

export type WorktreeReclaim =
  | { readonly outcome: "absent" }
  | { readonly outcome: "removed"; readonly archiveTag: string | null; readonly unmergedCommits: number }
  | { readonly outcome: "retained"; readonly reason: string };

export interface ScheduleOccurrenceWorkspace {
  readonly rootDir: string;
  readonly cwd: string;
  readonly runtime: TrustedScheduleRuntime;
}

/** Checks the worktree out (onto its existing branch when one survived a removed checkout); returns a link note. */
export async function addManagedWorktree(rootDir: string, worktree: ManagedWorktree): Promise<string | null> {
  const branchExists = await git(rootDir, "branch", "--list", worktree.branch);
  await git(
    rootDir,
    "worktree",
    "add",
    worktree.cwd,
    ...(branchExists ? [worktree.branch] : ["-b", worktree.branch, worktree.baseRef]),
  );
  return linkSharedNodeModules(rootDir, worktree.cwd);
}

/**
 * dec_BBA713052997C3EF5F5D3DD952 CH2: uncommitted changes keep the worktree; otherwise it is removed with its
 * branch, and commits whose patches are not upstream yet (`git cherry` "+", so merge, rebase and squash
 * merges all count as upstream) first stay reachable from an archive/wt-<name> tag. Nothing is forced.
 */
export async function reclaimManagedWorktree(rootDir: string, worktree: ManagedWorktree): Promise<WorktreeReclaim> {
  if (!existsSync(worktree.cwd)) return { outcome: "absent" };
  try {
    // The mirrored node_modules is this module's own doing, not the work in the worktree.
    if ((await git(worktree.cwd, "status", "--porcelain", "--", ".", ":(exclude)node_modules")).length > 0)
      return { outcome: "retained", reason: "uncommitted changes" };
    const unmergedCommits = (await git(worktree.cwd, "cherry", worktree.baseRef, "HEAD"))
        .split("\n")
        .filter((line) => line.startsWith("+")).length,
      archiveTag = unmergedCommits > 0 ? `archive/wt-${path.basename(worktree.cwd)}` : null;
    if (archiveTag) await git(worktree.cwd, "tag", archiveTag, "HEAD");
    if (!(await git(worktree.cwd, "ls-files", "--", "node_modules")))
      rmSync(path.join(worktree.cwd, "node_modules"), { recursive: true, force: true });
    await git(rootDir, "worktree", "remove", worktree.cwd);
    await git(rootDir, "branch", "-D", worktree.branch);
    return { outcome: "removed", archiveTag, unmergedCommits };
  } catch (error) {
    return { outcome: "retained", reason: `cleanup failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** What a reclaim left for a person to know about; a plain removal says nothing. */
export function reclaimDetail(label: string, worktree: ManagedWorktree, result: WorktreeReclaim): string | null {
  if (result.outcome === "retained") return `${label} retained at ${worktree.cwd} (${result.reason}).`;
  if (result.outcome === "removed" && result.archiveTag)
    return (
      `${label} ${worktree.cwd} removed; ${result.unmergedCommits} unmerged commit` +
      `${result.unmergedCommits === 1 ? "" : "s"} kept at tag ${result.archiveTag}.`
    );
  return null;
}

export async function prepareScheduleOccurrenceWorkspace(
  rootDir: string,
  schedule: ScheduleV1,
): Promise<ScheduleOccurrenceWorkspace> {
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
    cwd = path.join(rootDir, ".worktrees", branch),
    note = await addManagedWorktree(rootDir, { cwd, branch, baseRef: "origin/main" });
  return {
    rootDir,
    cwd,
    runtime: { ...base, worktree: { cwd, branch, baseRef: "origin/main", ...(note ? { note } : {}) } },
  };
}

// npm workspaces hoist every package's dependencies to the repository root store, so the fresh worktree
// shares that store entry by entry instead of installing. Linking the whole store would also share its
// workspace links, and every workspace import would resolve to the canonical checkout's source
// (F-81A23176); npm writes those links relative (@scope/pkg -> ../../packages/pkg), so a copy of the link
// lands in the worktree's own packages. This is best-effort: a repo without node_modules (non-node) or a
// filesystem that refuses the links must not fail the worktree — the note is reported to the caller instead.
export function linkSharedNodeModules(rootDir: string, worktreeDir: string): string | null {
  try {
    if (!existsSync(path.join(rootDir, "node_modules")) || existsSync(path.join(worktreeDir, "node_modules")))
      return null;
    mirrorStore(rootDir, worktreeDir, "node_modules");
    return null;
  } catch (error) {
    return `Worktree has no linked node_modules (${error instanceof Error ? error.message : String(error)}).`;
  }
}

/** Scope directories and .bin hold links of their own, so they are mirrored rather than linked. */
function mirrorStore(rootDir: string, worktreeDir: string, relative: string): void {
  mkdirSync(path.join(worktreeDir, relative));
  for (const entry of readdirSync(path.join(rootDir, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name),
      source = path.join(rootDir, name);
    if (entry.isDirectory() && (entry.name.startsWith("@") || entry.name === ".bin")) {
      mirrorStore(rootDir, worktreeDir, name);
      continue;
    }
    const link = entry.isSymbolicLink() ? readlinkSync(source) : null,
      inRepository =
        link !== null &&
        !path.isAbsolute(link) &&
        !path.relative(rootDir, path.resolve(path.dirname(source), link)).startsWith(".."),
      type = statSync(source, { throwIfNoEntry: false })?.isDirectory() ? "junction" : "file";
    symlinkSync(inRepository ? link : source, path.join(worktreeDir, name), type);
  }
}

export async function settleScheduleOccurrenceWorkspace(
  rootDir: string,
  schedule: TrustedScheduleRuntime,
): Promise<{ readonly detail: string | null }> {
  const worktree = schedule.worktree;
  if (!worktree) return { detail: null };
  return { detail: reclaimDetail("Occurrence worktree", worktree, await reclaimManagedWorktree(rootDir, worktree)) };
}

export async function scheduleSettlementDetail(
  rootDir: string,
  schedule: TrustedScheduleRuntime,
  detail: string | null,
): Promise<string | null> {
  const reclaimed = (await settleScheduleOccurrenceWorkspace(rootDir, schedule)).detail;
  return [schedule.worktree?.note, detail, reclaimed].filter(Boolean).join(" ") || null;
}

function git(cwd: string, ...args: string[]): Promise<string> {
  return runProcessTextAsync("git", ["-C", cwd, ...args]).then((output) => output.trim());
}
