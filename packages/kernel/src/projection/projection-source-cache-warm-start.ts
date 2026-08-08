import type { HarnessLayoutInput } from "../layout/index.ts";
import { resolveHarnessLayout } from "../layout/index.ts";
import { readProjectionSourceCacheSnapshot } from "./sqlite-projection-source-cache.ts";
import { restoreProjectionSourceCacheSnapshot } from "./sqlite-projection-source-cache-restore.ts";

export type ProjectionSourceWarmStart = "warmed" | "stale" | "already-attempted" | "unavailable";

const warmStartedProjectionSources = new Set<string>();

/**
 * Seed the in-process authored-source caches from the persisted projection
 * source cache.
 *
 * A cold process has no cached bodies, so an authored-source capture reads every
 * task, decision, declared-entity and attribution file from disk. The projection
 * database already carries those bodies together with the stat signature each one
 * had when it was persisted, so a cold capture can be turned into a re-stat of the
 * same set instead of a re-read of it.
 *
 * This is a cache seed, never a shortcut around validation. Bodies are content
 * hashed on read (`projectionSourceCacheSnapshot`) and again on restore, and every
 * seeded entry is only reused by a reader whose stat signatures still match disk;
 * any added, removed or modified source falls back to a full authored read. The
 * capture that follows therefore computes the same fingerprint a cold read would.
 *
 * Warming is attempted at most once per process for a given root and projection so
 * that a long-lived writer keeps whatever newer state its own reads have produced.
 */
export function warmStartProjectionSourceCaches(
  rootInput: HarnessLayoutInput,
  projectionPath?: string
): ProjectionSourceWarmStart {
  const layout = resolveHarnessLayout(rootInput);
  const resolvedProjectionPath = projectionPath ?? layout.projectionPath;
  const key = `${layout.rootDir}\0${resolvedProjectionPath}`;
  if (warmStartedProjectionSources.has(key)) return "already-attempted";
  warmStartedProjectionSources.add(key);
  try {
    const restored = restoreProjectionSourceCacheSnapshot(
      rootInput,
      readProjectionSourceCacheSnapshot(resolvedProjectionPath)
    );
    if (!restored.valid) return "unavailable";
    return restored.task === "fresh" && restored.attribution === "fresh" ? "warmed" : "stale";
  } catch {
    // A missing, unreadable or superseded projection database is not authoritative;
    // the caller falls back to a full authored-source read.
    return "unavailable";
  }
}
