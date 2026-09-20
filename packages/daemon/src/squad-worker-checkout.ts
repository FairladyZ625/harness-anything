import path from "node:path";
import { existsSync } from "node:fs";
import { localGitObjectRefStore } from "../../kernel/src/index.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import { runProcessTextAsync } from "./process-port.ts";

/** Where a squad worker runs: the run cwd, or its own worktree and branch cut at the run baseline. */
export type WorkerCheckout = { readonly cwd: string; readonly branch: string; readonly baseSha: string };

export function resolveCwd(rootDir: string, value: unknown): string {
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
  state: { readonly squadRunId: string; readonly cwd: string; readonly baseSha: string | null },
  workerId: string,
  attemptId: string,
): Promise<WorkerCheckout | null> {
  if (state.baseSha === null) return null;
  const slug = `squad-${state.squadRunId.slice("squad_".length)}-${workerId}-${attemptId}`,
    branch = `codex/${slug}`,
    cwd = path.join(state.cwd, ".worktrees", slug);
  if (existsSync(cwd)) {
    const currentBranch = (await runProcessTextAsync("git", ["branch", "--show-current"], cwd)).trim();
    if (currentBranch !== branch) throw new Error(`Squad checkout ${cwd} does not hold ${branch}.`);
    await runProcessTextAsync("git", ["merge-base", "--is-ancestor", state.baseSha, "HEAD"], cwd);
  } else {
    localGitObjectRefStore.addWorktree(state.cwd, cwd, branch, state.baseSha);
  }
  return { cwd, branch, baseSha: state.baseSha };
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
