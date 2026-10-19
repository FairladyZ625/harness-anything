import { existsSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { resolveHarnessLayout } from "@harness-anything/kernel";
import { readDispatchStreamHeaders } from "./dispatch-stream.ts";
import { removeRuntimeCallbackRelay } from "./runtime-callback-relay.ts";

const derivedDirectories = [
  "cache",
  "adopt-claims",
  "generated",
  "restore-drills",
  "runtime/dispatches",
  "doc-sync-claims",
  "fleet-uploads",
  "conflicts",
  "presets",
] as const;

export const cachePurgePreservedPaths = Object.freeze([
  ".harness/store",
  ".harness/wal",
  ".harness/store/imports",
  "harness",
  ".worktrees",
  ".gitignore",
]);

export function purgeRepoCache(rootDir: string): readonly string[] {
  const canonicalRoot = realpathSync(rootDir),
    localRoot = resolveHarnessLayout(canonicalRoot).localRoot,
    dispatchIds = readDispatchStreamHeaders(canonicalRoot, true).map((header) => header.dispatchId),
    removed: string[] = [];
  for (const dispatchId of dispatchIds) removeRuntimeCallbackRelay(dispatchId);
  for (const relative of derivedDirectories) {
    const target = path.join(localRoot, ...relative.split("/"));
    if (!existsSync(target)) continue;
    rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    removed.push(`.harness/${relative}`);
  }
  return removed.sort();
}

/** Deletes the repository's local and authored Harness roots; callers must have a drilled backup first. */
export function removeRepoHarnessRoots(rootDir: string): readonly string[] {
  const layout = resolveHarnessLayout(realpathSync(rootDir)),
    removed: string[] = [];
  for (const [target, receiptPath] of [
    [layout.localRoot, ".harness"],
    [layout.authoredRoot, "harness"],
  ] as const) {
    if (!existsSync(target)) continue;
    rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    removed.push(receiptPath);
  }
  return removed;
}
