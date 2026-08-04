import path from "node:path";
import type { HarnessLayoutInput } from "../layout/index.ts";
import { resolveHarnessLayout, type HarnessLayout } from "../layout/index.ts";
import type { VersionControlSystem } from "../ports/version-control-system.ts";
import { readDeclaredSourceManifestRows } from "./sqlite-declared-source-manifest.ts";
import { updateTaskProjectionIncrementally } from "./sqlite-task-incremental-projection.ts";
import { stablePayloadHash } from "../integrity/stable-hash.ts";
import {
  captureProjectionSourceFingerprint,
  summarizeProjectionSourceFingerprint,
  type ProjectionSourceSummary
} from "./projection-source-snapshot.ts";

export interface ProjectionSourceWorktreeFenceDiagnostic {
  readonly clean: boolean;
  readonly statusCount: number;
  readonly sourceDirtyCount: number;
  readonly unparseableStatusCount: number;
  readonly sourceDirtyCategoryHash: string;
}

export type TrustedProjectionFingerprintDiagnostic =
  | {
      readonly kind: "cache";
      readonly outcome: "hit" | "full-capture";
      readonly reason: string;
      readonly head: string;
      readonly cachedHead?: string;
      readonly cachedFingerprint?: string;
      readonly worktreeVerified?: boolean;
      readonly fence?: ProjectionSourceWorktreeFenceDiagnostic;
      readonly summary?: ProjectionSourceSummary;
    }
  | {
      readonly kind: "advance";
      readonly outcome: "advanced" | "not-advanced";
      readonly reason: string;
      readonly head: string;
      readonly cachedHead: string;
      readonly cachedFingerprint: string;
      readonly fingerprint?: string;
      readonly fence: ProjectionSourceWorktreeFenceDiagnostic;
    };

export interface TrustedProjectionFingerprintOptions {
  readonly onDiagnostic?: (diagnostic: TrustedProjectionFingerprintDiagnostic) => void;
}

interface TrustedProjectionFingerprint {
  readonly head: string;
  readonly fingerprint: string;
  readonly worktreeVerified: boolean;
}

const trustedProjectionFingerprints = new Map<string, TrustedProjectionFingerprint>();

export function captureAuthoredProjectionFingerprint(rootInput: HarnessLayoutInput): string {
  return captureAuthoredProjectionSource(rootInput).fingerprint;
}

function captureAuthoredProjectionSource(rootInput: HarnessLayoutInput) {
  const projectionPath = resolveHarnessLayout(rootInput).projectionPath;
  let hints: ReturnType<typeof readDeclaredSourceManifestRows> = [];
  try {
    hints = readDeclaredSourceManifestRows(projectionPath);
  } catch {
    // A missing or invalid generated manifest is not authoritative; source capture still proceeds.
  }
  return captureProjectionSourceFingerprint(rootInput, hints);
}

/**
 * Reuse the source hash for a clean, unchanged projection-source generation. A write
 * coordinator and the ledger materializer share this cache, so one generation
 * pays for a full source capture once and later publications advance it from
 * their touched paths. A cold cache gets a Git HEAD plus scoped worktree fence;
 * a successful projection update promotes the same generation to a verified
 * cache entry, so later calls do not refresh the whole index. If HEAD has
 * advanced through a known ancestor chain, the persisted projection is
 * advanced from the changed paths before the cache is reused. The incremental
 * updater still verifies the touched generation and falls back to a full
 * rebuild on any mismatch.
 */
export function captureTrustedAuthoredProjectionFingerprint(
  rootInput: HarnessLayoutInput,
  vcs: VersionControlSystem,
  repoRoot?: string,
  options: TrustedProjectionFingerprintOptions = {}
): string {
  const layout = resolveHarnessLayout(rootInput);
  const resolvedRepoRoot = repoRoot ?? vcs.topLevel(layout.authoredRoot) ?? vcs.topLevel(layout.rootDir);
  if (!resolvedRepoRoot) {
    const source = captureAuthoredProjectionSource(rootInput);
    options.onDiagnostic?.({
      kind: "cache",
      outcome: "full-capture",
      reason: "repo-root-unavailable",
      head: "unresolved",
      summary: summarizeProjectionSourceFingerprint(source)
    });
    return source.fingerprint;
  }

  const key = trustedProjectionFingerprintKey(resolvedRepoRoot, layout.authoredRoot, layout.projectionPath);
  const head = vcs.currentHead(resolvedRepoRoot);
  const cached = trustedProjectionFingerprints.get(key);
  if (cached && cached.head === head) {
    if (cached.worktreeVerified) {
      options.onDiagnostic?.({
        kind: "cache",
        outcome: "hit",
        reason: "same-head-verified",
        head,
        cachedHead: cached.head,
        cachedFingerprint: cached.fingerprint,
        worktreeVerified: true
      });
      return cached.fingerprint;
    }
    const fence = projectionSourceWorktreeIsClean(vcs, resolvedRepoRoot, layout);
    if (fence.clean) {
      options.onDiagnostic?.({
        kind: "cache",
        outcome: "hit",
        reason: "same-head-fence-clean",
        head,
        cachedHead: cached.head,
        cachedFingerprint: cached.fingerprint,
        worktreeVerified: false,
        fence
      });
      return cached.fingerprint;
    }
    options.onDiagnostic?.({
      kind: "cache",
      outcome: "full-capture",
      reason: "same-head-fence-dirty",
      head,
      cachedHead: cached.head,
      cachedFingerprint: cached.fingerprint,
      worktreeVerified: false,
      fence
    });
  }
  if (cached && cached.head !== head) {
    const fence = projectionSourceWorktreeIsClean(vcs, resolvedRepoRoot, layout);
    if (fence.clean) {
      const advanced = advanceTrustedProjectionFingerprint(
        rootInput,
        layout,
        vcs,
        resolvedRepoRoot,
        cached,
        head
      );
      if (advanced.fingerprint) {
        options.onDiagnostic?.({
          kind: "advance",
          outcome: "advanced",
          reason: advanced.reason,
          head,
          cachedHead: cached.head,
          cachedFingerprint: cached.fingerprint,
          fingerprint: advanced.fingerprint,
          fence
        });
        return advanced.fingerprint;
      }
      options.onDiagnostic?.({
        kind: "advance",
        outcome: "not-advanced",
        reason: advanced.reason,
        head,
        cachedHead: cached.head,
        cachedFingerprint: cached.fingerprint,
        fence
      });
    } else {
      options.onDiagnostic?.({
        kind: "advance",
        outcome: "not-advanced",
        reason: "head-advanced-fence-dirty",
        head,
        cachedHead: cached.head,
        cachedFingerprint: cached.fingerprint,
        fence
      });
    }
  }

  const source = captureAuthoredProjectionSource(rootInput);
  const fingerprint = source.fingerprint;
  const capturedHead = vcs.currentHead(resolvedRepoRoot);
  if (capturedHead === head) {
    trustedProjectionFingerprints.set(key, { head: capturedHead, fingerprint, worktreeVerified: false });
  } else {
    trustedProjectionFingerprints.delete(key);
  }
  options.onDiagnostic?.({
    kind: "cache",
    outcome: "full-capture",
    reason: cached ? "trusted-cache-not-reusable" : "cache-cold",
    head,
    ...(cached ? { cachedHead: cached.head, cachedFingerprint: cached.fingerprint } : {}),
    summary: summarizeProjectionSourceFingerprint(source)
  });
  return fingerprint;
}

function advanceTrustedProjectionFingerprint(
  rootInput: HarnessLayoutInput,
  layout: ReturnType<typeof resolveHarnessLayout>,
  vcs: VersionControlSystem,
  repoRoot: string,
  cached: TrustedProjectionFingerprint,
  head: string
): { readonly fingerprint?: string; readonly reason: string } {
  if (cached.head === head) return { fingerprint: cached.fingerprint, reason: "same-head" };
  if (!vcs.resolveCommit(repoRoot, cached.head).ok) {
    return { reason: "cached-head-unresolvable" };
  }

  let changedPaths: ReadonlyArray<string>;
  try {
    changedPaths = vcs.changedFilesBetween(repoRoot, cached.head, head);
  } catch {
    return { reason: "changed-paths-read-failed" };
  }

  const result = updateTaskProjectionIncrementally({
    rootDir: layout.rootDir,
    ...(typeof rootInput === "object" && rootInput.layoutOverrides
      ? { layoutOverrides: rootInput.layoutOverrides }
      : {}),
    projectionPath: layout.projectionPath,
    touchedPaths: changedPaths.map((relativePath) => path.resolve(repoRoot, relativePath)),
    previousSourceFingerprint: cached.fingerprint
  });
  if (!result.sourceHash) {
    return {
      reason: `projection-advance-${result.mode}-${result.mode === "rebuild" ? result.rebuildReason : "no-source-hash"}`
    };
  }
  if (vcs.currentHead(repoRoot) !== head) return { reason: "head-changed-during-advance" };

  const key = trustedProjectionFingerprintKey(repoRoot, layout.authoredRoot, layout.projectionPath);
  trustedProjectionFingerprints.set(key, {
    head,
    fingerprint: result.sourceHash,
    worktreeVerified: true
  });
  return { fingerprint: result.sourceHash, reason: "known-ancestor-incremental" };
}

/*
 * The fence is intentionally scoped to projection-relevant source classes.
 * Its diagnostic reports only aggregate categories, so a permanently enabled
 * always-on production frame cannot disclose authored paths.
 */
function projectionSourceWorktreeIsClean(
  vcs: VersionControlSystem,
  repoRoot: string,
  layout: HarnessLayout
): ProjectionSourceWorktreeFenceDiagnostic {
  const relativeRoot = path.relative(vcs.normalizePath(repoRoot), vcs.normalizePath(layout.authoredRoot)).split(path.sep).join("/");
  try {
    const status = vcs.workingTreeFiles(repoRoot, relativeRoot.length === 0 ? [] : [relativeRoot]);
    const lines = status.split(/\r?\n/u).filter(Boolean);
    const categories = new Map<string, number>();
    let unparseableStatusCount = 0;
    for (const line of lines) {
      const parsed = parseWorktreeStatusPath(line);
      const category = parsed === null
        ? "unparseable-status"
        : projectionSourcePathCategory(layout, relativeRoot, parsed);
      if (category) categories.set(category, (categories.get(category) ?? 0) + 1);
      if (parsed === null) unparseableStatusCount += 1;
    }
    const sourceDirtyCount = [...categories.values()].reduce((sum, count) => sum + count, 0);
    return {
      clean: sourceDirtyCount === 0,
      statusCount: lines.length,
      sourceDirtyCount,
      unparseableStatusCount,
      sourceDirtyCategoryHash: stablePayloadHash({
        schema: "projection-source-worktree-fence/v1",
        categories: [...categories.entries()].sort(([left], [right]) => left.localeCompare(right))
      })
    };
  } catch {
    return {
      clean: false,
      statusCount: 0,
      sourceDirtyCount: 0,
      unparseableStatusCount: 0,
      sourceDirtyCategoryHash: stablePayloadHash({
        schema: "projection-source-worktree-fence/v1",
        categories: [["status-read-failed", 1]]
      })
    };
  }
}

function parseWorktreeStatusPath(statusLine: string): string | null {
  if (statusLine.length < 4 || statusLine[2] !== " ") return null;
  const pathPart = statusLine.slice(3);
  if (pathPart.includes('"')) return null;
  const renameSeparator = pathPart.lastIndexOf(" -> ");
  return (renameSeparator >= 0 ? pathPart.slice(renameSeparator + 4) : pathPart).replaceAll("\\", "/");
}

function projectionSourcePathCategory(
  layout: HarnessLayout,
  relativeRoot: string,
  statusPath: string
): string | null {
  const authoredPrefix = relativeRoot.length === 0 ? "" : `${relativeRoot}/`;
  if (!statusPath.startsWith(authoredPrefix)) return "outside-authored-root";
  const relativePath = statusPath.slice(authoredPrefix.length);
  const tasksRoot = relativePathFromAuthoredRoot(layout, layout.tasksRoot);
  const decisionsRoot = relativePathFromAuthoredRoot(layout, layout.decisionsRoot);
  const sessionsRoot = relativePathFromAuthoredRoot(layout, layout.sessionsRoot);
  const attributionRoot = relativePathFromAuthoredRoot(layout, layout.attributionEventsRoot);
  const authorityAttributionRoot = relativePathFromAuthoredRoot(layout, layout.authorityAttributionEventsV2Root);

  if (relativePath === "people.yaml") return "people";
  if (relativePath === attributionRoot || relativePath.startsWith(`${attributionRoot}/`)) return "v1-attribution";
  if (relativePath === authorityAttributionRoot || relativePath.startsWith(`${authorityAttributionRoot}/`)) return "v2-attribution";
  if (relativePath.startsWith(`${sessionsRoot}/`)) return /^.+\.md$/u.test(relativePath.slice(sessionsRoot.length + 1)) ? "session" : null;
  if (relativePath.startsWith(`${decisionsRoot}/`)) return path.basename(relativePath) === "decision.md" ? "decision" : null;
  if (!relativePath.startsWith(`${tasksRoot}/`)) return null;

  const taskRelativePath = relativePath.slice(tasksRoot.length + 1);
  if (/^.+\/(?:executions|consents|reviews)\/[^/]+\.md$/u.test(taskRelativePath)) return "declared-entity";
  return /^.+\/(?:INDEX|facts|module|review|closeout)\.md$/u.test(taskRelativePath) ? "task-source" : null;
}

function relativePathFromAuthoredRoot(layout: HarnessLayout, inputPath: string): string {
  return path.relative(layout.authoredRoot, inputPath).split(path.sep).join("/");
}

export function rememberTrustedAuthoredProjectionFingerprint(
  rootInput: HarnessLayoutInput,
  fingerprint: string,
  vcs: VersionControlSystem,
  repoRoot?: string
): void {
  const layout = resolveHarnessLayout(rootInput);
  const resolvedRepoRoot = repoRoot ?? vcs.topLevel(layout.authoredRoot) ?? vcs.topLevel(layout.rootDir);
  if (!resolvedRepoRoot) return;
  const key = trustedProjectionFingerprintKey(resolvedRepoRoot, layout.authoredRoot, layout.projectionPath);
  trustedProjectionFingerprints.set(key, {
    head: vcs.currentHead(resolvedRepoRoot),
    fingerprint,
    worktreeVerified: true
  });
}

export function invalidateTrustedAuthoredProjectionFingerprint(
  rootInput: HarnessLayoutInput,
  vcs: VersionControlSystem,
  repoRoot?: string
): void {
  const layout = resolveHarnessLayout(rootInput);
  const resolvedRepoRoot = repoRoot ?? vcs.topLevel(layout.authoredRoot) ?? vcs.topLevel(layout.rootDir);
  if (!resolvedRepoRoot) return;
  trustedProjectionFingerprints.delete(
    trustedProjectionFingerprintKey(resolvedRepoRoot, layout.authoredRoot, layout.projectionPath)
  );
}

function trustedProjectionFingerprintKey(repoRoot: string, authoredRoot: string, projectionPath: string): string {
  return [path.resolve(repoRoot), path.resolve(authoredRoot), path.resolve(projectionPath)].join("\0");
}
