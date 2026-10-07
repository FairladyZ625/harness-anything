import path from "node:path";
import { existsSync } from "node:fs";
import type { TaskProjection } from "@harness-anything/kernel";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import { runProcessTextAsync } from "./process-port.ts";
import { addManagedWorktree, reclaimManagedWorktree, type WorktreeReclaim } from "./schedule-occurrence-workspace.ts";
import { checkoutTaskWorktree, openTaskWorktreeBinding, presetSnapshotReader } from "./task-worktree.ts";
import { runWorktreeSetup, worktreeSetupFailure } from "./worktree-setup.ts";

/** Where a squad worker runs: the run cwd, or its own worktree and branch cut at the run baseline. */
export type WorkerCheckout = { readonly cwd: string; readonly branch: string; readonly baseSha: string };

const workerBranchSeparator = "--";

/** Without a requested cwd a Squad run works in its task's own worktree, checked out and prepared on first use. */
export async function resolveSquadCwd(
  rootDir: string,
  value: unknown,
  query: <T>(read: (projection: TaskProjection) => T) => T,
  taskId: string,
  setup: readonly string[],
): Promise<string> {
  if (value !== undefined) return resolveCwd(rootDir, value);
  const binding = query((read) => openTaskWorktreeBinding(read.read(taskId).snapshot.task, presetSnapshotReader(read))),
    checkout = binding ? await checkoutTaskWorktree(rootDir, taskId, binding, setup) : null;
  if (checkout && !checkout.setup.ok)
    throw new Error(worktreeSetupFailure(checkout.cwd, checkout.setup, `start the Squad run for ${taskId} again`));
  return checkout?.cwd ?? rootDir;
}

function resolveCwd(rootDir: string, value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return rootDir;
  const row = value as Record<string, unknown>;
  if (row.scope === "repo-root") return rootDir;
  if (row.scope === "repo-relative" && typeof row.path === "string") return path.resolve(rootDir, row.path);
  throw new Error("Squad cwd must be repository-relative.");
}

export function cwdPayload(rootDir: string, cwd: string): JsonObject {
  const relative = path.relative(rootDir, cwd);
  return relative ? { scope: "repo-relative", path: relative } : { scope: "repo-root" };
}

/** Writing workers get their own worktree when the run cwd is a Git work tree with a commit; a cwd without
 * a Git baseline (a Git-less edge, or a repo before its first commit) keeps the shared cwd. */
export async function prepareWorkerWorktree(
  state: { readonly squadRunId: string; readonly cwd: string },
  baseSha: string | null,
  workerId: string,
  attemptId: string,
  setup: { readonly rootDir: string; readonly taskId: string; readonly steps: readonly string[] },
): Promise<WorkerCheckout | null> {
  if (baseSha === null) return null;
  // Workers branch off whatever the Commander has checked out, so the Commander can merge them back
  // with the child SHAs intact. A detached HEAD owns no ref to hang siblings from.
  const commanderBranch = (await runProcessTextAsync("git", ["branch", "--show-current"], state.cwd)).trim();
  if (!commanderBranch) throw new Error("Squad workers require the Commander to run on a checked-out branch.");
  const slug = `squad-${state.squadRunId.slice("squad_".length)}-${workerId}-${attemptId}`,
    // Git cannot create refs/heads/<mission>/worker while refs/heads/<mission> exists.
    // A sibling ref retains the visible mission owner without colliding with the Commander ref.
    branch = `${commanderBranch}${workerBranchSeparator}${slug}`,
    cwd = path.join(state.cwd, ".worktrees", slug);
  if (existsSync(cwd)) {
    const currentBranch = (await runProcessTextAsync("git", ["branch", "--show-current"], cwd)).trim();
    if (currentBranch !== branch) throw new Error(`Squad checkout ${cwd} does not hold ${branch}.`);
    await runProcessTextAsync("git", ["merge-base", "--is-ancestor", baseSha, "HEAD"], cwd);
  } else {
    await addManagedWorktree(state.cwd, { cwd, branch, baseRef: baseSha });
  }
  const prepared = await runWorktreeSetup({ rootDir: setup.rootDir, cwd, taskId: setup.taskId, steps: setup.steps });
  if (!prepared.ok) throw new Error(worktreeSetupFailure(cwd, prepared, "let the Commander dispatch the worker again"));
  return { cwd, branch, baseSha };
}

/** A finished run's worker checkout is reclaimed against the Commander branch its work merges into. */
export function reclaimWorkerWorktree(commanderCwd: string, worktree: WorkerCheckout): Promise<WorktreeReclaim> {
  return reclaimManagedWorktree(commanderCwd, {
    cwd: worktree.cwd,
    branch: worktree.branch,
    baseRef: worktree.branch.slice(0, worktree.branch.lastIndexOf(`${workerBranchSeparator}squad-`)),
  });
}

/**
 * A finished run's worker checkouts end by the managed-worktree rule (dec_BBA713052997C3EF5F5D3DD952 CH3): merged or
 * archived ones go; one with uncommitted changes stays at the path the run's status still lists, and is named here.
 */
export async function reclaimWorkerCheckouts(
  commanderCwd: string,
  attempts: readonly { readonly worktree: WorkerCheckout | null }[],
): Promise<readonly string[]> {
  const retained: string[] = [];
  for (const { worktree } of attempts) {
    if (!worktree) continue;
    const result = await reclaimWorkerWorktree(commanderCwd, worktree);
    if (result.outcome === "retained") retained.push(`Worker worktree retained at ${worktree.cwd} (${result.reason}).`);
  }
  return retained;
}

export function workerPrompt(prompt: string, worktree: WorkerCheckout | null, ownedPaths: readonly string[]): string {
  const ownership =
    `Declared write ownership: ${JSON.stringify(ownedPaths)}. ` +
    "The Commander receives findings for committed changes outside these paths.";
  if (worktree === null) return `${prompt}\n\n${ownership}`;
  return [
    prompt,
    ownership,
    "# Squad worker checkout",
    `Worker repository root: ${worktree.cwd}`,
    `Worker branch: ${worktree.branch}`,
    `Worker baseline: ${worktree.baseSha}`,
  ].join("\n\n");
}
