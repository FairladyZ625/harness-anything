import { existsSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import { resolveHarnessLayout } from "@harness-anything/kernel";
import { mustPreserveDispatch, readDispatchStreamHeaders, removeDispatchStream } from "./dispatch-stream.ts";
import { removeRuntimeCallbackRelay } from "./runtime-callback-relay.ts";

export type LocalRootLeafClass = "derived" | "authoritative" | "unrecognized";

/**
 * The one list of local paths a cache purge may delete. Everything else in the local root is
 * authoritative and preserved, so membership here is the only evidence that an entry can be
 * regenerated. `repo-local-root-residue.ts` reads this list instead of keeping its own opinion.
 */
export const cachePurgeDerivedDirectories = [
  "cache",
  "adopt-claims",
  "generated",
  "restore-drills",
  "runtime/dispatches",
  "runtime/sealed-skills",
  "doc-sync-claims",
  "fleet-uploads",
  "conflicts",
  "presets",
] as const;

/** What a cache purge keeps, named against this repository's own roots instead of a fixed `.harness`. */
export function cachePurgePreservedPaths(rootDir: string): readonly string[] {
  const layout = resolveHarnessLayout(rootDir);
  return Object.freeze([
    ...["store", "wal", "store/imports"].map(
      (relative) => `${path.relative(layout.rootDir, layout.localRoot)}/${relative}`,
    ),
    path.relative(layout.rootDir, layout.authoredRoot),
    ".worktrees",
    ".gitignore",
  ]);
}

export function purgeRepoCache(rootDir: string): readonly string[] {
  const canonicalRoot = realpathSync.native(rootDir),
    layout = resolveHarnessLayout(canonicalRoot),
    localRoot = layout.localRoot,
    dispatchIds = readDispatchStreamHeaders(canonicalRoot, true).map((header) => header.dispatchId),
    pendingEvidence = new Set(dispatchIds.filter((dispatchId) => mustPreserveDispatch(canonicalRoot, dispatchId))),
    removed: string[] = [];
  for (const dispatchId of dispatchIds) removeRuntimeCallbackRelay(dispatchId);
  for (const relative of cachePurgeDerivedDirectories) {
    const target = path.join(localRoot, ...relative.split("/"));
    if (!existsSync(target)) continue;
    // A pending evidence stream is not regenerable cache: settlement failed to publish its
    // snapshot, so the raw live/archived bytes are the only recoverable copy. Remove the other
    // dispatch streams but leave those files (and the directory that holds them) in place.
    if (relative === "runtime/dispatches" && pendingEvidence.size > 0) {
      for (const dispatchId of dispatchIds)
        if (!pendingEvidence.has(dispatchId)) removeDispatchStream(canonicalRoot, dispatchId);
      continue;
    }
    /* @gate-identity non-state/environment-io.a4b2ae42a0d210f8 */ rmSync(target, {
      recursive: true,
      force: true,
      maxRetries: storageReadPolicy.defaultValue.cachePurgeRetry.maxRetries,
      retryDelay: storageReadPolicy.defaultValue.cachePurgeRetry.retryDelayMs,
    });
    removed.push(`${path.relative(layout.rootDir, path.join(localRoot, ...relative.split("/")))}`);
  }
  return removed.sort();
}

/** Relative directory prefixes under `layout.localRoot` that a cache purge preserves. */
export function cachePurgePreservedLocalDirectories(rootDir: string): readonly string[] {
  const layout = resolveHarnessLayout(rootDir),
    localPrefix = `${path.relative(layout.rootDir, layout.localRoot).split(path.sep).join("/")}/`;
  return cachePurgePreservedPaths(rootDir)
    .map((entry) => entry.split(path.sep).join("/"))
    .flatMap((normalized) => (normalized.startsWith(localPrefix) ? [normalized.slice(localPrefix.length)] : []));
}

/**
 * Shared leaf-level classification for paths relative to `layout.localRoot`.
 * Directory entries in `cachePurgeDerivedDirectories` and `preserved` cover files strictly inside
 * that directory (`${prefix}/...`); a symbolic link replacing the directory entry itself is never
 * treated as derived or authoritative.
 */
export function classifyLocalRootLeaf(
  relativeFromLocalRoot: string,
  preservedLocalDirectories: readonly string[],
  options?: { readonly isSymbolicLink?: boolean },
): LocalRootLeafClass {
  const coveredBy = (prefixes: readonly string[]): boolean =>
    prefixes.some(
      (prefix) =>
        relativeFromLocalRoot.startsWith(`${prefix}/`) ||
        (!options?.isSymbolicLink && relativeFromLocalRoot === prefix),
    );
  if (coveredBy(cachePurgeDerivedDirectories)) return "derived";
  return coveredBy(preservedLocalDirectories) ? "authoritative" : "unrecognized";
}

export function aggregateLocalRootEntryClass(classes: readonly LocalRootLeafClass[]): LocalRootLeafClass {
  if (classes.includes("unrecognized")) return "unrecognized";
  return classes.includes("authoritative") ? "authoritative" : "derived";
}

/** Deletes the repository's local and authored Harness roots; callers must have a drilled backup first. */
export function removeRepoHarnessRoots(rootDir: string): readonly string[] {
  const layout = resolveHarnessLayout(realpathSync.native(rootDir)),
    removed: string[] = [];
  for (const [target, receiptPath] of [
    [layout.localRoot, path.relative(layout.rootDir, layout.localRoot)],
    [layout.authoredRoot, path.relative(layout.rootDir, layout.authoredRoot)],
  ] as const) {
    if (!existsSync(target)) continue;
    /* @gate-identity non-state/environment-io.9bc5b49b9a770b83 */ rmSync(target, {
      recursive: true,
      force: true,
      maxRetries: storageReadPolicy.defaultValue.cachePurgeRetry.maxRetries,
      retryDelay: storageReadPolicy.defaultValue.cachePurgeRetry.retryDelayMs,
    });
    removed.push(receiptPath);
  }
  return removed;
}
