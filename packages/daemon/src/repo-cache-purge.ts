import { existsSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { resolveHarnessLayout } from "@harness-anything/kernel";
import { readDispatchStreamHeaders, readDispatchStreamSummary, removeDispatchStream } from "./dispatch-stream.ts";
import { readDispatchEvidenceState } from "./dispatch-evidence-state.ts";
import { removeRuntimeCallbackRelay } from "./runtime-callback-relay.ts";

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
  const canonicalRoot = realpathSync(rootDir),
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
    /* @gate-identity state-store/legacy.a4b2ae42a0d210f8 */ rmSync(target, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
    removed.push(`${path.relative(layout.rootDir, path.join(localRoot, ...relative.split("/")))}`);
  }
  return removed.sort();
}

/**
 * Whether one dispatch stream is still the only copy of an abnormal run. A sidecar decides this
 * without reading the bounded summary; a missing sidecar on a tracked stream (header version 1)
 * is fail-closed, and a legacy stream with an unreadable/abnormal terminal is preserved too.
 */
function mustPreserveDispatch(rootDir: string, dispatchId: string): boolean {
  const state = readDispatchEvidenceState(rootDir, dispatchId);
  if (state === "pending") return true;
  if (state !== null) return false;
  const summary = readDispatchStreamSummary(rootDir, dispatchId);
  if (summary?.header.evidenceTrackingVersion === 1) return true;
  if (summary?.evidenceState === "pending") return true;
  // Legacy streams carry no sidecar and no tracking header: keep the historical cache-purge
  // behavior unless the readable terminal is actually abnormal.
  if (summary === null || summary.terminalOutcome === null) return false;
  const outcome = summary.terminalOutcome.payload.outcome,
    classification = summary.terminalOutcome.payload.attempt?.classification;
  return outcome !== "succeeded" && classification !== "awaiting_ruling";
}

/** Deletes the repository's local and authored Harness roots; callers must have a drilled backup first. */
export function removeRepoHarnessRoots(rootDir: string): readonly string[] {
  const layout = resolveHarnessLayout(realpathSync(rootDir)),
    removed: string[] = [];
  for (const [target, receiptPath] of [
    [layout.localRoot, path.relative(layout.rootDir, layout.localRoot)],
    [layout.authoredRoot, path.relative(layout.rootDir, layout.authoredRoot)],
  ] as const) {
    if (!existsSync(target)) continue;
    /* @gate-identity state-store/legacy.9bc5b49b9a770b83 */ rmSync(target, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
    removed.push(receiptPath);
  }
  return removed;
}
