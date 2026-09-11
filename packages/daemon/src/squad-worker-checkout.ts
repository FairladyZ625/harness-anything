import path from "node:path";
import { localGitObjectRefStore } from "../../kernel/src/index.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";

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
export function prepareWorkerWorktree(
  state: { readonly squadRunId: string; readonly cwd: string; readonly baseSha: string | null },
  workerId: string,
): WorkerCheckout | null {
  if (state.baseSha === null) return null;
  const slug = `squad-${state.squadRunId.slice("squad_".length)}-${workerId}`,
    branch = `codex/${slug}`,
    cwd = path.join(state.cwd, ".worktrees", slug);
  localGitObjectRefStore.addWorktree(state.cwd, cwd, branch, state.baseSha);
  return { cwd, branch, baseSha: state.baseSha };
}

export function workerPrompt(prompt: string, worktree: WorkerCheckout | null): string {
  if (worktree === null) return prompt;
  return [
    prompt,
    "# Squad worker checkout",
    `Worker repository root: ${worktree.cwd}`,
    `Worker branch: ${worktree.branch}`,
    `Worker baseline: ${worktree.baseSha}`,
  ].join("\n\n");
}
