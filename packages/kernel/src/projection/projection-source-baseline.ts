import path from "node:path";
import type { HarnessLayoutInput } from "../layout/index.ts";
import { resolveHarnessLayout, type HarnessLayout } from "../layout/index.ts";
import type { VersionControlSystem } from "../ports/version-control-system.ts";
import { readDeclaredSourceManifestRows } from "./sqlite-declared-source-manifest.ts";
import { updateTaskProjectionIncrementally } from "./sqlite-task-incremental-projection.ts";
import { captureProjectionSourceFingerprint } from "./projection-source-snapshot.ts";

interface TrustedProjectionFingerprint {
  readonly head: string;
  readonly fingerprint: string;
  readonly worktreeVerified: boolean;
}

const trustedProjectionFingerprints = new Map<string, TrustedProjectionFingerprint>();

export function captureAuthoredProjectionFingerprint(rootInput: HarnessLayoutInput): string {
  const projectionPath = resolveHarnessLayout(rootInput).projectionPath;
  let hints: ReturnType<typeof readDeclaredSourceManifestRows> = [];
  try {
    hints = readDeclaredSourceManifestRows(projectionPath);
  } catch {
    // A missing or invalid generated manifest is not authoritative; source capture still proceeds.
  }
  return captureProjectionSourceFingerprint(rootInput, hints).fingerprint;
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
  repoRoot?: string
): string {
  const layout = resolveHarnessLayout(rootInput);
  const resolvedRepoRoot = repoRoot ?? vcs.topLevel(layout.authoredRoot) ?? vcs.topLevel(layout.rootDir);
  if (!resolvedRepoRoot) return captureAuthoredProjectionFingerprint(rootInput);

  const key = trustedProjectionFingerprintKey(resolvedRepoRoot, layout.authoredRoot, layout.projectionPath);
  const head = vcs.currentHead(resolvedRepoRoot);
  const cached = trustedProjectionFingerprints.get(key);
  if (cached && cached.head === head) {
    if (cached.worktreeVerified || projectionSourceWorktreeIsClean(vcs, resolvedRepoRoot, layout)) {
      return cached.fingerprint;
    }
  }
  if (cached && projectionSourceWorktreeIsClean(vcs, resolvedRepoRoot, layout)) {
    const advanced = advanceTrustedProjectionFingerprint(
      rootInput,
      layout,
      vcs,
      resolvedRepoRoot,
      cached,
      head
    );
    if (advanced) return advanced;
  }

  const fingerprint = captureAuthoredProjectionFingerprint(rootInput);
  const capturedHead = vcs.currentHead(resolvedRepoRoot);
  if (capturedHead === head) {
    trustedProjectionFingerprints.set(key, { head: capturedHead, fingerprint, worktreeVerified: false });
  } else {
    trustedProjectionFingerprints.delete(key);
  }
  return fingerprint;
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

function projectionSourceWorktreeIsClean(vcs: VersionControlSystem, repoRoot: string, layout: HarnessLayout): boolean {
  const relativeRoot = path.relative(vcs.normalizePath(repoRoot), vcs.normalizePath(layout.authoredRoot)).split(path.sep).join("/");
  try {
    const status = vcs.workingTreeFiles(repoRoot, relativeRoot.length === 0 ? [] : [relativeRoot]);
    return status
      .split(/\r?\n/u)
      .filter(Boolean)
      .map(parseWorktreeStatusPath)
      .every((relativePath) => relativePath !== null && !isProjectionSourcePath(layout, relativeRoot, relativePath));
  } catch {
    return false;
  }
}

function parseWorktreeStatusPath(statusLine: string): string | null {
  if (statusLine.length < 4 || statusLine[2] !== " ") return null;
  const pathPart = statusLine.slice(3);
  if (pathPart.includes('"')) return null;
  const renameSeparator = pathPart.lastIndexOf(" -> ");
  return (renameSeparator >= 0 ? pathPart.slice(renameSeparator + 4) : pathPart).replaceAll("\\", "/");
}

function isProjectionSourcePath(layout: HarnessLayout, relativeRoot: string, statusPath: string): boolean {
  const authoredPrefix = relativeRoot.length === 0 ? "" : `${relativeRoot}/`;
  if (!statusPath.startsWith(authoredPrefix)) return true;
  const relativePath = statusPath.slice(authoredPrefix.length);
  const tasksRoot = relativePathFromAuthoredRoot(layout, layout.tasksRoot);
  const decisionsRoot = relativePathFromAuthoredRoot(layout, layout.decisionsRoot);
  const sessionsRoot = relativePathFromAuthoredRoot(layout, layout.sessionsRoot);
  const attributionRoot = relativePathFromAuthoredRoot(layout, layout.attributionEventsRoot);
  const authorityAttributionRoot = relativePathFromAuthoredRoot(layout, layout.authorityAttributionEventsV2Root);

  if (relativePath === "people.yaml") return true;
  if (relativePath === attributionRoot || relativePath.startsWith(`${attributionRoot}/`)) return true;
  if (relativePath === authorityAttributionRoot || relativePath.startsWith(`${authorityAttributionRoot}/`)) return true;
  if (relativePath.startsWith(`${sessionsRoot}/`)) return /^.+\.md$/u.test(relativePath.slice(sessionsRoot.length + 1));
  if (relativePath.startsWith(`${decisionsRoot}/`)) return path.basename(relativePath) === "decision.md";
  if (!relativePath.startsWith(`${tasksRoot}/`)) return false;

  const taskRelativePath = relativePath.slice(tasksRoot.length + 1);
  return /^.+\/(?:INDEX|facts|module|review|closeout)\.md$/u.test(taskRelativePath) ||
    /^.+\/(?:executions|consents|reviews)\/[^/]+\.md$/u.test(taskRelativePath);
}

function relativePathFromAuthoredRoot(layout: HarnessLayout, inputPath: string): string {
  return path.relative(layout.authoredRoot, inputPath).split(path.sep).join("/");
}

function advanceTrustedProjectionFingerprint(
  rootInput: HarnessLayoutInput,
  layout: ReturnType<typeof resolveHarnessLayout>,
  vcs: VersionControlSystem,
  repoRoot: string,
  cached: TrustedProjectionFingerprint,
  head: string
): string | undefined {
  if (cached.head === head) return cached.fingerprint;
  if (!vcs.resolveCommit(repoRoot, cached.head).ok) return undefined;

  let changedPaths: ReadonlyArray<string>;
  try {
    changedPaths = vcs.changedFilesBetween(repoRoot, cached.head, head);
  } catch {
    return undefined;
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
  if (!result.sourceHash || vcs.currentHead(repoRoot) !== head) return undefined;

  const key = trustedProjectionFingerprintKey(repoRoot, layout.authoredRoot, layout.projectionPath);
  trustedProjectionFingerprints.set(key, {
    head,
    fingerprint: result.sourceHash,
    worktreeVerified: true
  });
  return result.sourceHash;
}
