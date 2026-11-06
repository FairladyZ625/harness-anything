import path from "node:path";
import type { TaskProjection, TaskWorktreeBindingV1 } from "@harness-anything/kernel";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import { runProcessTextAsync } from "./process-port.ts";
import { reclaimManagedWorktree, type WorktreeReclaim } from "./schedule-occurrence-workspace.ts";
import { checkoutTaskWorktree, openTaskWorktreeBinding, presetSnapshotReader } from "./task-worktree.ts";
import { worktreeSetupFailure, type WorktreeSetupSettings } from "./worktree-setup.ts";

/** Where a squad worker runs: the run cwd, or its own worktree and branch cut at the run baseline. */
export type WorkerCheckout = { readonly cwd: string; readonly branch: string; readonly baseSha: string };

/** Without a requested cwd a Squad run works in its task's own worktree, checked out and prepared on first use. */
export async function resolveSquadCwd(
  rootDir: string,
  value: unknown,
  query: <T>(read: (projection: TaskProjection) => T) => T,
  taskId: string,
  worktree: WorktreeSetupSettings,
): Promise<string> {
  if (value !== undefined) return resolveCwd(rootDir, value);
  const binding = query((read) => openTaskWorktreeBinding(read.read(taskId).snapshot.task, presetSnapshotReader(read))),
    checkout = binding ? await checkoutTaskWorktree(rootDir, taskId, binding, worktree) : null;
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

/** A worker commits in its child task's bound worktree, cut from the Commander's current stage.
 * A second squad-specific checkout would diverge from the HEAD that task submit freezes. */
export async function prepareWorkerWorktree(
  baseSha: string | null,
  binding: TaskWorktreeBindingV1 | null,
  setup: { readonly rootDir: string; readonly taskId: string } & WorktreeSetupSettings,
): Promise<WorkerCheckout | null> {
  if (baseSha === null || binding === null) return null;
  const checkout = await checkoutTaskWorktree(setup.rootDir, setup.taskId, binding, setup, undefined, baseSha);
  if (!checkout) return null;
  if (!checkout.setup.ok)
    throw new Error(worktreeSetupFailure(checkout.cwd, checkout.setup, "let the Commander dispatch the worker again"));
  return { cwd: checkout.cwd, branch: checkout.branch, baseSha };
}

/** A finished run's worker checkout is reclaimed against the Commander branch its work merges into. */
export async function reclaimWorkerWorktree(commanderCwd: string, worktree: WorkerCheckout): Promise<WorktreeReclaim> {
  return reclaimManagedWorktree(commanderCwd, {
    cwd: worktree.cwd,
    branch: worktree.branch,
    baseRef: (await runProcessTextAsync("git", ["rev-parse", "HEAD"], commanderCwd)).trim(),
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
