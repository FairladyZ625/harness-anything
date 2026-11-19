import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  consumeKnownError,
  DISPATCH_LIFECYCLE_PAGE_LIMIT,
  dispatchOwnerForNode,
  resolveHarnessLayout,
  type DispatchLifecycleView,
  type TaskProjectionQueries,
} from "@harness-anything/kernel";
import { removeFileDurably } from "../../../storage/src/durable-file.ts";
import { readDispatchEvidenceState, removeDispatchEvidenceState } from "./dispatch-evidence-state.ts";
import { archiveDispatchStreams, mustPreserveDispatch, readDispatchStreamSummary } from "./dispatch-stream.ts";
import {
  pruneDispatchStreamArchive,
  tryReadFactEvidenceSources,
  type DispatchArchiveRetention,
} from "./dispatch-stream-archive.ts";
import {
  aggregateLocalRootEntryClass,
  cachePurgeDerivedDirectories,
  cachePurgePreservedLocalDirectories,
  classifyLocalRootLeaf,
  type LocalRootLeafClass,
} from "./repo-cache-purge.ts";
import { isDaemonRequestLogFileName } from "./request-log.ts";
import { isHandoffCheckpointIrreversiblyRetired, readHandoffCheckpoint } from "./runtime-handoff-store.ts";

export type LocalRootEntryClass = LocalRootLeafClass;

export interface LocalRootStorageEntry {
  readonly name: string;
  readonly classification: LocalRootEntryClass;
  readonly bytes: number;
  readonly files: number;
  readonly byClass: Readonly<Record<LocalRootEntryClass, { readonly bytes: number; readonly files: number }>>;
}

export interface LocalRootStorageHighlight {
  readonly path: string;
  readonly classification: LocalRootEntryClass | "historical";
  readonly bytes: number;
  readonly files: number;
  readonly note: string;
}

export interface LocalRootStorageReport {
  readonly schema: "doctor-storage/v1";
  readonly byteMetric: "apparent-bytes";
  readonly rootDir: string;
  readonly localRoot: string;
  readonly relativeLocalRoot: string;
  readonly exists: boolean;
  readonly totalBytes: number;
  readonly totalFiles: number;
  readonly byClass: Readonly<Record<LocalRootEntryClass, { readonly bytes: number; readonly files: number }>>;
  readonly entries: readonly LocalRootStorageEntry[];
  readonly highlights: readonly LocalRootStorageHighlight[];
}

export interface LocalRootReclaimResult {
  readonly archivedDispatches: number;
  readonly nextAfterDispatchId: string | null;
  readonly removedOrphanSidecars: number;
  readonly removedHandoffRollouts: number;
  readonly removedStaleCacheFiles: number;
  readonly archivePruned: boolean;
  readonly skippedReason: string | null;
}

const dispatchFilePattern = /^dispatch_([a-f0-9]{24})\.jsonl$/u;
const evidenceSidecarPattern = /^dispatch_([a-f0-9]{24})\.evidence-state\.json$/u;
const dispatchIdPattern = /^dispatch_[a-f0-9]{24}$/u;
const verificationCacheSuffixes = ["", "-wal", "-shm"] as const;

function emptyClassTotals(): Record<LocalRootEntryClass, { bytes: number; files: number }> {
  return {
    authoritative: { bytes: 0, files: 0 },
    derived: { bytes: 0, files: 0 },
    unrecognized: { bytes: 0, files: 0 },
  };
}

/**
 * Iterative O(entries) apparent-byte (`st_size`) inventory of `layout.localRoot`, classified
 * leaf-by-leaf against `repo-cache-purge.ts` without crossing any symbolic link boundary.
 */
export function measureLocalRootStorage(rootDir: string): LocalRootStorageReport {
  const layout = resolveHarnessLayout(rootDir),
    relativeLocalRoot = toPosix(path.relative(layout.rootDir, layout.localRoot) || "."),
    preservedLocalDirs = cachePurgePreservedLocalDirectories(layout.rootDir),
    byClass = emptyClassTotals(),
    ownedLocalRoot = resolveOwnedLocalRoot(layout);
  if (ownedLocalRoot === null) {
    return {
      schema: "doctor-storage/v1",
      byteMetric: "apparent-bytes",
      rootDir: layout.rootDir,
      localRoot: layout.localRoot,
      relativeLocalRoot,
      exists: false,
      totalBytes: 0,
      totalFiles: 0,
      byClass,
      entries: [],
      highlights: [],
    };
  }
  const entries: LocalRootStorageEntry[] = [];
  for (const name of readdirSync(ownedLocalRoot)) {
    const entryByClass = walkOwnedEntry(ownedLocalRoot, name, preservedLocalDirs),
      bytes = entryByClass.authoritative.bytes + entryByClass.derived.bytes + entryByClass.unrecognized.bytes,
      files = entryByClass.authoritative.files + entryByClass.derived.files + entryByClass.unrecognized.files,
      presentClasses = (["authoritative", "derived", "unrecognized"] as const).filter(
        (kind) => entryByClass[kind].files > 0,
      ),
      classification: LocalRootEntryClass =
        presentClasses.length > 0
          ? aggregateLocalRootEntryClass(presentClasses)
          : classifyEmptyDirectory(name, preservedLocalDirs);
    for (const kind of ["authoritative", "derived", "unrecognized"] as const) {
      byClass[kind].bytes += entryByClass[kind].bytes;
      byClass[kind].files += entryByClass[kind].files;
    }
    entries.push({ name, classification, bytes, files, byClass: entryByClass });
  }
  entries.sort((left, right) => right.bytes - left.bytes || left.name.localeCompare(right.name));
  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0),
    totalFiles = entries.reduce((sum, entry) => sum + entry.files, 0);
  return {
    schema: "doctor-storage/v1",
    byteMetric: "apparent-bytes",
    rootDir: layout.rootDir,
    localRoot: layout.localRoot,
    relativeLocalRoot,
    exists: true,
    totalBytes,
    totalFiles,
    byClass,
    entries,
    highlights: buildStorageHighlights(ownedLocalRoot),
  };
}

/**
 * Reclaim settled/proven-stopped runtime artifacts and leaked verification/retired cache in
 * bounded writer turns (`maxDispatches`, default `DISPATCH_LIFECYCLE_PAGE_LIMIT`).
 * Never crosses symbolic links, never touches canonical `store/` or `wal/`, preserves abnormal
 * legacy streams via `mustPreserveDispatch`, preserves `cancelled` handoff rollouts, and reads
 * the Fact projection at most once.
 */
export function reclaimLocalRootStorage(input: {
  readonly rootDir: string;
  readonly projection: Pick<
    TaskProjectionQueries,
    "read" | "readDispatchLifecycle" | "readRuntimeDispatchByResumeSource" | "searchFacts"
  >;
  readonly retention: DispatchArchiveRetention;
  readonly nowMs?: number;
  readonly ownerNodeId?: string;
  readonly recoveryDispatchIds?: readonly string[];
  readonly liveRuntimeSessionIds?: ReadonlySet<string>;
  readonly maxDispatches?: number;
  readonly afterDispatchId?: string;
  readonly compactArchived?: boolean;
  readonly runNonDispatchSweep?: boolean;
}): LocalRootReclaimResult {
  const layout = resolveHarnessLayout(input.rootDir),
    ownedLocalRoot = resolveOwnedLocalRoot(layout);
  if (ownedLocalRoot === null) {
    return {
      archivedDispatches: 0,
      nextAfterDispatchId: null,
      removedOrphanSidecars: 0,
      removedHandoffRollouts: 0,
      removedStaleCacheFiles: 0,
      archivePruned: false,
      skippedReason: lstatSync(layout.localRoot, { throwIfNoEntry: false })
        ? "localRoot physical boundary check failed"
        : null,
    };
  }

  const recoverySet = new Set(input.recoveryDispatchIds ?? []),
    doneTaskCache = new Map<string, boolean>(),
    maxDispatches = Math.max(1, input.maxDispatches ?? DISPATCH_LIFECYCLE_PAGE_LIMIT),
    dispatchResult = archiveSettledDispatchStreams({
      rootDir: layout.rootDir,
      ownedLocalRoot,
      projection: input.projection,
      owner: dispatchOwnerForNode(input.ownerNodeId),
      recoverySet,
      liveRuntimeSessionIds: input.liveRuntimeSessionIds,
      doneTaskCache,
      maxDispatches,
      afterDispatchId: input.afterDispatchId,
      compactArchived: input.compactArchived !== false,
    });

  if (input.runNonDispatchSweep === false) {
    return {
      archivedDispatches: dispatchResult.archived,
      nextAfterDispatchId: dispatchResult.nextAfterDispatchId,
      removedOrphanSidecars: 0,
      removedHandoffRollouts: 0,
      removedStaleCacheFiles: 0,
      archivePruned: false,
      skippedReason: dispatchResult.skippedReason,
    };
  }

  const removedOrphanSidecars = pruneOrphanEvidenceSidecars(layout.rootDir, ownedLocalRoot),
    removedHandoffRollouts = pruneRetiredHandoffRollouts(
      layout.rootDir,
      ownedLocalRoot,
      input.projection,
      doneTaskCache,
    ),
    removedStaleCacheFiles = pruneStaleDerivedFiles(ownedLocalRoot);

  let archivePruned = false,
    skippedReason: string | null = dispatchResult.skippedReason;
  const ownedDispatchesDir = resolveOwnedDirectory(ownedLocalRoot, "runtime", "dispatches");
  if (ownedDispatchesDir === null || isSafeSubdirectoryOrAbsent(ownedDispatchesDir, "archive")) {
    const factSources = tryReadFactEvidenceSources(input.projection);
    if (factSources.status !== "ready") {
      skippedReason = skippedReason ?? "fact projection pending";
    } else {
      if (ownedDispatchesDir !== null) {
        pruneDispatchStreamArchive(
          layout.rootDir,
          input.retention,
          factSources.sources,
          input.nowMs ?? Date.now(),
          input.recoveryDispatchIds ?? [],
        );
      }
      archivePruned = true;
    }
  }

  return {
    archivedDispatches: dispatchResult.archived,
    nextAfterDispatchId: dispatchResult.nextAfterDispatchId,
    removedOrphanSidecars,
    removedHandoffRollouts,
    removedStaleCacheFiles,
    archivePruned,
    skippedReason,
  };
}

/**
 * Schedule post-adoption local-root reclamation across bounded writer turns so heavy tasks with
 * thousands of settled dispatches never monopolize the single-writer queue or rewrite transcripts
 * synchronously before `scheduleArchivedDispatchStreamCompaction` interleaves them.
 *
 * Monotonic cursor: `afterDispatchId` strictly increases in lexicographic `dispatch_<hex>` order;
 * termination signal: `result.nextAfterDispatchId === null` or `result.skippedReason !== null`.
 */
export function scheduleLocalRootReclamation(input: {
  readonly rootDir: string;
  readonly projection: () => Pick<
    TaskProjectionQueries,
    "read" | "readDispatchLifecycle" | "readRuntimeDispatchByResumeSource" | "searchFacts"
  >;
  readonly readRetention: () => DispatchArchiveRetention;
  readonly schedule: (work: () => void | Promise<void>) => void;
  readonly ownerNodeId?: string;
  readonly recoveryDispatchIds?: readonly string[];
  readonly maxDispatchesPerTurn?: number;
  readonly onComplete?: () => void;
}): void {
  let afterDispatchId: string | undefined;
  const enqueueTurn = (finalSweepOnly = false): void => {
    input.schedule(() => {
      if (finalSweepOnly) {
        reclaimLocalRootStorage({
          rootDir: input.rootDir,
          projection: input.projection(),
          retention: input.readRetention(),
          ownerNodeId: input.ownerNodeId,
          recoveryDispatchIds: input.recoveryDispatchIds,
          maxDispatches: 1,
          afterDispatchId: "dispatch_ffffffffffffffffffffffff",
          compactArchived: false,
          runNonDispatchSweep: true,
        });
        input.onComplete?.();
        return;
      }
      const result = reclaimLocalRootStorage({
        rootDir: input.rootDir,
        projection: input.projection(),
        retention: input.readRetention(),
        ownerNodeId: input.ownerNodeId,
        recoveryDispatchIds: input.recoveryDispatchIds,
        maxDispatches: input.maxDispatchesPerTurn ?? DISPATCH_LIFECYCLE_PAGE_LIMIT,
        ...(afterDispatchId === undefined ? {} : { afterDispatchId }),
        compactArchived: false,
        runNonDispatchSweep: false,
      });
      if (result.nextAfterDispatchId !== null && result.skippedReason === null) {
        afterDispatchId = result.nextAfterDispatchId;
        enqueueTurn(false);
        return;
      }
      enqueueTurn(true);
    });
  };
  enqueueTurn(false);
}

function archiveSettledDispatchStreams(input: {
  readonly rootDir: string;
  readonly ownedLocalRoot: string;
  readonly projection: Pick<TaskProjectionQueries, "read" | "readDispatchLifecycle">;
  readonly owner: string;
  readonly recoverySet: ReadonlySet<string>;
  readonly liveRuntimeSessionIds?: ReadonlySet<string>;
  readonly doneTaskCache: Map<string, boolean>;
  readonly maxDispatches: number;
  readonly afterDispatchId?: string;
  readonly compactArchived: boolean;
}): { readonly archived: number; readonly nextAfterDispatchId: string | null; readonly skippedReason: string | null } {
  const ownedDispatchesDir = resolveOwnedDirectory(input.ownedLocalRoot, "runtime", "dispatches");
  if (ownedDispatchesDir === null) return { archived: 0, nextAfterDispatchId: null, skippedReason: null };
  if (
    !isSafeSubdirectoryOrAbsent(ownedDispatchesDir, "archive") ||
    !isSafeSubdirectoryOrAbsent(ownedDispatchesDir, "live-index")
  )
    return { archived: 0, nextAfterDispatchId: null, skippedReason: "dispatch subdirectory boundary check failed" };

  const allLiveIds = readdirSync(ownedDispatchesDir)
    .flatMap((name) => {
      const match = dispatchFilePattern.exec(name);
      if (!match) return [];
      return readOwnedRegularFileStat(ownedDispatchesDir, name) ? [`dispatch_${match[1]}`] : [];
    })
    .sort();
  const remaining =
    input.afterDispatchId === undefined ? allLiveIds : allLiveIds.filter((id) => id > input.afterDispatchId!);
  if (remaining.length === 0) return { archived: 0, nextAfterDispatchId: null, skippedReason: null };

  const batch = remaining.slice(0, input.maxDispatches),
    nextAfterDispatchId = remaining.length > batch.length ? batch.at(-1)! : null;

  const viewsById = new Map<string, DispatchLifecycleView>();
  for (let offset = 0; offset < batch.length; offset += DISPATCH_LIFECYCLE_PAGE_LIMIT) {
    const page = input.projection.readDispatchLifecycle({
      by: "dispatch",
      dispatchIds: batch.slice(offset, offset + DISPATCH_LIFECYCLE_PAGE_LIMIT),
    });
    if (page.status !== "ready")
      return { archived: 0, nextAfterDispatchId: null, skippedReason: "dispatch lifecycle projection pending" };
    for (const row of page.rows) viewsById.set(row.attempt.dispatchId, row);
  }

  const toArchive: string[] = [];
  for (const dispatchId of batch) {
    if (input.recoverySet.has(dispatchId)) continue;
    if (mustPreserveDispatch(input.rootDir, dispatchId)) continue;
    const view = viewsById.get(dispatchId);
    if (view !== undefined) {
      if (!view.attempt.fence.verified || view.attempt.fence.owner !== input.owner) continue;
      if (input.liveRuntimeSessionIds?.has(view.attempt.runtimeSessionId) || view.policy.processAlive) continue;
      if (!view.policy.attemptSettled || view.attempt.stopProof !== "proven_stopped") continue;
      const groupFinal =
        view.policy.groupSettled &&
        (!view.policy.successorAdmissible ||
          (view.attempt.task !== null &&
            isTaskIrreversiblyDoneCached(input.projection, view.attempt.task.taskId, input.doneTaskCache)));
      if (!groupFinal) continue;
      toArchive.push(dispatchId);
      continue;
    }
    const summary = readDispatchStreamSummary(input.rootDir, dispatchId);
    if (!summary || input.liveRuntimeSessionIds?.has(summary.header.runtimeSessionId)) continue;
    const headerOwner =
      summary.header.executionOwner === undefined || summary.header.executionOwner === "local"
        ? "local"
        : `node:${summary.header.executionOwner.nodeId}`;
    if (headerOwner !== input.owner) continue;
    if (summary.process?.exited !== true) continue;
    if (summary.terminalOutcome === null || summary.header.taskId === null) continue;
    if (!isTaskIrreversiblyDoneCached(input.projection, summary.header.taskId, input.doneTaskCache)) continue;
    toArchive.push(dispatchId);
  }

  const archived =
    toArchive.length === 0
      ? 0
      : archiveDispatchStreams(input.rootDir, toArchive, { compact: input.compactArchived }).length;
  return { archived, nextAfterDispatchId, skippedReason: null };
}

function pruneOrphanEvidenceSidecars(rootDir: string, ownedLocalRoot: string): number {
  const ownedDispatchesDir = resolveOwnedDirectory(ownedLocalRoot, "runtime", "dispatches");
  if (ownedDispatchesDir === null) return 0;
  if (!isSafeSubdirectoryOrAbsent(ownedDispatchesDir, "archive")) return 0;
  const ownedArchiveDir = resolveOwnedDirectory(ownedLocalRoot, "runtime", "dispatches", "archive"),
    presentStreams = new Set<string>();
  for (const directory of [ownedDispatchesDir, ...(ownedArchiveDir ? [ownedArchiveDir] : [])]) {
    for (const name of readdirSync(directory)) {
      const match = dispatchFilePattern.exec(name);
      if (match && readOwnedRegularFileStat(directory, name)) presentStreams.add(`dispatch_${match[1]}`);
    }
  }
  let removed = 0;
  for (const name of readdirSync(ownedDispatchesDir)) {
    const match = evidenceSidecarPattern.exec(name);
    if (!match || !readOwnedRegularFileStat(ownedDispatchesDir, name)) continue;
    const dispatchId = `dispatch_${match[1]}`;
    if (presentStreams.has(dispatchId)) continue;
    if (readDispatchEvidenceState(rootDir, dispatchId) === "pending") continue;
    removeDispatchEvidenceState(rootDir, dispatchId);
    removed += 1;
  }
  return removed;
}

function pruneRetiredHandoffRollouts(
  rootDir: string,
  ownedLocalRoot: string,
  projection: Pick<TaskProjectionQueries, "read" | "readRuntimeDispatchByResumeSource">,
  doneTaskCache: Map<string, boolean>,
): number {
  const ownedHandoffsRoot = resolveOwnedDirectory(ownedLocalRoot, "runtime-handoffs");
  if (ownedHandoffsRoot === null) return 0;
  let removed = 0;
  for (const name of readdirSync(ownedHandoffsRoot)) {
    if (!dispatchIdPattern.test(name)) continue;
    const ownedEntryDir = resolveOwnedDirectory(ownedHandoffsRoot, name);
    if (ownedEntryDir === null) continue;
    const rolloutFile = readOwnedRegularFileStat(ownedEntryDir, "rollout.jsonl"),
      checkpointFile = readOwnedRegularFileStat(ownedEntryDir, "checkpoint.json");
    if (!rolloutFile || !checkpointFile) continue;
    const checkpoint = readHandoffCheckpoint(rootDir, name);
    if (!checkpoint) continue;
    if (!isHandoffCheckpointIrreversiblyRetired(checkpoint, projection, doneTaskCache)) continue;
    removeFileDurably(rolloutFile.path);
    removed += 1;
  }
  return removed;
}

function pruneStaleDerivedFiles(ownedLocalRoot: string): number {
  const ownedCacheDir = resolveOwnedDirectory(ownedLocalRoot, "cache");
  if (ownedCacheDir === null) return 0;
  let removedStaleCacheFiles = 0;
  const removeWithSidecars = (stem: string) => {
    for (const suffix of verificationCacheSuffixes) {
      const file = readOwnedRegularFileStat(ownedCacheDir, `${stem}${suffix}`);
      if (!file) continue;
      removeFileDurably(file.path);
      removedStaleCacheFiles += 1;
    }
  };
  removeWithSidecars("completion-conversion-verification.sqlite");
  if (readOwnedRegularFileStat(ownedCacheDir, "task.sqlite")) removeWithSidecars("projections.sqlite");
  return removedStaleCacheFiles;
}

function isTaskIrreversiblyDoneCached(
  projection: Pick<TaskProjectionQueries, "read">,
  taskId: string,
  cache: Map<string, boolean>,
): boolean {
  const cached = cache.get(taskId);
  if (cached !== undefined) return cached;
  const read = projection.read(taskId),
    done = read.status === "ready" && read.snapshot.task?.status === "done";
  cache.set(taskId, done);
  return done;
}

function buildStorageHighlights(ownedLocalRoot: string): readonly LocalRootStorageHighlight[] {
  const directoryHighlights: {
    readonly path: string;
    readonly segments: readonly string[];
    readonly classification: LocalRootStorageHighlight["classification"];
    readonly note: string;
  }[] = [
    {
      path: "store/generations",
      segments: ["store", "generations"],
      classification: "authoritative",
      note: "Canonical SQLite event ledger and content objects; never auto-reclaimed.",
    },
    {
      path: "store/retired",
      segments: ["store", "retired"],
      classification: "historical",
      note: "Retired pre-v3 SQLite generations kept after offline conversion; manual delete only after backup.",
    },
    {
      path: "store/imports",
      segments: ["store", "imports"],
      classification: "authoritative",
      note: "Imported legacy snapshot baseline; preserved.",
    },
    {
      path: "runtime/dispatches/archive",
      segments: ["runtime", "dispatches", "archive"],
      classification: "derived",
      note: "Compacted terminal dispatch streams; pruned by retentionDays/retentionBytes except Fact evidence.",
    },
    {
      path: "runtime-handoffs",
      segments: ["runtime-handoffs"],
      classification: "unrecognized",
      note: "Cross-node handoff checkpoints and rollouts; rollout.jsonl is reclaimed only once revoked, consumed, or task is done.",
    },
  ];
  const fileHighlights: {
    readonly path: string;
    readonly dirSegments: readonly string[];
    readonly fileName: string;
    readonly classification: LocalRootStorageHighlight["classification"];
    readonly note: string;
  }[] = [
    {
      path: "cache/task.sqlite",
      dirSegments: ["cache"],
      fileName: "task.sqlite",
      classification: "derived",
      note: "Active SQLite projection cache; rebuildable via ha daemon projection rebuild.",
    },
    {
      path: "cache/completion-conversion-verification.sqlite",
      dirSegments: ["cache"],
      fileName: "completion-conversion-verification.sqlite",
      classification: "derived",
      note: "One-off conversion verification cache; safe to reclaim automatically.",
    },
  ];

  const highlights: LocalRootStorageHighlight[] = [];
  for (const candidate of directoryHighlights) {
    const ownedDir = resolveOwnedDirectory(ownedLocalRoot, ...candidate.segments);
    if (!ownedDir) continue;
    const stats = walkOwnedDirectorySize(ownedLocalRoot, ownedDir);
    highlights.push({
      path: candidate.path,
      classification: candidate.classification,
      bytes: stats.bytes,
      files: stats.files,
      note: candidate.note,
    });
  }
  for (const candidate of fileHighlights) {
    const ownedDir = resolveOwnedDirectory(ownedLocalRoot, ...candidate.dirSegments);
    if (!ownedDir) continue;
    const file = readOwnedRegularFileStat(ownedDir, candidate.fileName);
    if (!file) continue;
    highlights.push({
      path: candidate.path,
      classification: candidate.classification,
      bytes: file.size,
      files: 1,
      note: candidate.note,
    });
  }
  const ownedRequestsDir = resolveOwnedDirectory(ownedLocalRoot, "requests");
  if (ownedRequestsDir) {
    let logBytes = 0,
      logFiles = 0;
    for (const name of readdirSync(ownedRequestsDir)) {
      if (!isDaemonRequestLogFileName(name)) continue;
      const stat = readOwnedRegularFileStat(ownedRequestsDir, name);
      if (!stat) continue;
      logBytes += stat.size;
      logFiles += 1;
    }
    if (logFiles > 0) {
      highlights.push({
        path: "requests/requests.jsonl*",
        classification: "derived",
        bytes: logBytes,
        files: logFiles,
        note: "Daemon request observability logs owned by request-log writer (4 MiB rotation, 7-day age pruning); non-log siblings excluded.",
      });
    }
  }
  return highlights;
}

function classifyEmptyDirectory(name: string, preservedLocalDirs: readonly string[]): LocalRootEntryClass {
  if ((cachePurgeDerivedDirectories as readonly string[]).includes(name)) return "derived";
  return preservedLocalDirs.includes(name) ? "authoritative" : "unrecognized";
}

function walkOwnedEntry(
  ownedLocalRoot: string,
  entryName: string,
  preservedLocalDirs: readonly string[],
): Record<LocalRootEntryClass, { bytes: number; files: number }> {
  const totals = emptyClassTotals(),
    stack: { readonly target: string; readonly relative: string }[] = [
      { target: path.join(ownedLocalRoot, entryName), relative: entryName },
    ];
  while (stack.length > 0) {
    const { target, relative } = stack.pop()!,
      stat = lstatSync(target, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      const kind = classifyLocalRootLeaf(relative, preservedLocalDirs, { isSymbolicLink: stat.isSymbolicLink() });
      totals[kind].bytes += stat.size;
      totals[kind].files += 1;
      continue;
    }
    const realDir = safeRealpath(target);
    if (!realDir || !isStrictRealChild(ownedLocalRoot, realDir)) continue;
    for (const child of readdirSync(realDir)) {
      stack.push({ target: path.join(realDir, child), relative: `${relative}/${child}` });
    }
  }
  return totals;
}

function walkOwnedDirectorySize(
  ownedLocalRoot: string,
  ownedStartDir: string,
): { readonly bytes: number; readonly files: number } {
  const stack = [ownedStartDir];
  let bytes = 0,
    files = 0;
  while (stack.length > 0) {
    const current = stack.pop()!,
      stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      bytes += stat.size;
      files += 1;
      continue;
    }
    const realDir = safeRealpath(current);
    if (!realDir || (realDir !== ownedLocalRoot && !isStrictRealChild(ownedLocalRoot, realDir))) continue;
    for (const name of readdirSync(realDir)) stack.push(path.join(realDir, name));
  }
  return { bytes, files };
}

function resolveOwnedLocalRoot(layout: ReturnType<typeof resolveHarnessLayout>): string | null {
  if (!existsSync(layout.rootDir)) return null;
  const realRepoRoot = safeRealpath(layout.rootDir);
  if (!realRepoRoot) return null;
  const relativeSegments = path
    .relative(layout.rootDir, layout.localRoot)
    .split(path.sep)
    .filter((segment) => segment.length > 0 && segment !== ".");
  if (relativeSegments.length === 0 || relativeSegments.some((segment) => segment === "..")) return null;
  let current = realRepoRoot;
  for (const segment of relativeSegments) {
    const candidate = path.join(current, segment),
      stat = lstatSync(candidate, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return null;
    const realCandidate = safeRealpath(candidate);
    if (!realCandidate || !isStrictRealChild(realRepoRoot, realCandidate)) return null;
    current = realCandidate;
  }
  return current;
}

function resolveOwnedDirectory(ownedBaseDir: string, ...segments: readonly string[]): string | null {
  let current = ownedBaseDir;
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === ".." || segment.includes(path.sep)) return null;
    const candidate = path.join(current, segment),
      stat = lstatSync(candidate, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return null;
    const realCandidate = safeRealpath(candidate);
    if (!realCandidate || !isStrictRealChild(ownedBaseDir, realCandidate)) return null;
    current = realCandidate;
  }
  return current;
}

function isSafeSubdirectoryOrAbsent(ownedParentDir: string, childName: string): boolean {
  const candidate = path.join(ownedParentDir, childName),
    stat = lstatSync(candidate, { throwIfNoEntry: false });
  if (!stat) return true;
  if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
  const realCandidate = safeRealpath(candidate);
  return realCandidate !== null && isStrictRealChild(ownedParentDir, realCandidate);
}

function readOwnedRegularFileStat(
  ownedDirectory: string,
  fileName: string,
): { readonly path: string; readonly size: number } | null {
  if (fileName.length === 0 || fileName === "." || fileName === ".." || fileName.includes(path.sep)) return null;
  const target = path.join(ownedDirectory, fileName),
    stat = lstatSync(target, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) return null;
  return { path: target, size: stat.size };
}

function safeRealpath(target: string): string | null {
  try {
    return realpathSync(target);
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}

function isStrictRealChild(realParent: string, realCandidate: string): boolean {
  const prefix = realParent.endsWith(path.sep) ? realParent : `${realParent}${path.sep}`;
  return realCandidate.startsWith(prefix);
}

function toPosix(relative: string): string {
  return relative.split(path.sep).join("/");
}
