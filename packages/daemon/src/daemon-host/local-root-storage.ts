import { lstatSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  DISPATCH_LIFECYCLE_PAGE_LIMIT,
  dispatchOwnerForNode,
  resolveHarnessLayout,
  type DispatchLifecycleView,
  type TaskProjectionQueries,
} from "@harness-anything/kernel";
import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import type { FactEventV1 } from "@harness-anything/kernel/internal/domain/fact-event.ts";
import { removeFileDurably } from "../../../storage/src/durable-file.ts";
import { readDispatchEvidenceState, removeDispatchEvidenceState } from "./dispatch-evidence-state.ts";
import { archiveDispatchStreams, removeDispatchLiveIndexEntries } from "./dispatch-stream.ts";
import {
  isStrictRealChild,
  ownedSubdirectoryOrAbsent,
  resolveOwnedDirectory,
  resolveOwnedLocalRoot,
} from "./local-root-paths.ts";
import {
  pruneDispatchStreamArchiveSteps,
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
import { directoryEntries, scheduleMaintenance, type MaintenanceSchedule } from "./local-maintenance.ts";
import { isDaemonRequestLogFileName } from "./request-log.ts";
import { readHandoffCheckpoint, reclaimableHandoffRolloutReason } from "./runtime-handoff-store.ts";

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
  readonly removedOrphanSidecars: number;
  readonly removedHandoffRollouts: number;
  readonly removedStaleCacheFiles: number;
  readonly archivePruned: boolean;
  readonly skippedReason: string | null;
}

const dispatchFilePattern = /^dispatch_([a-f0-9]{24})\.jsonl$/u;
const evidenceSidecarPattern = /^dispatch_([a-f0-9]{24})\.evidence-state\.json$/u;
const dispatchIdPattern = /^dispatch_[a-f0-9]{24}$/u;
const evidenceCreationEvent: FactEventV1["type"] = "fact_recorded";
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
 * the Fact projection in a single paginated traversal.
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
}): LocalRootReclaimResult {
  const layout = resolveHarnessLayout(input.rootDir),
    ownedLocalRoot = resolveOwnedLocalRoot(layout);
  if (ownedLocalRoot === null) {
    return {
      archivedDispatches: 0,
      removedOrphanSidecars: 0,
      removedHandoffRollouts: 0,
      removedStaleCacheFiles: 0,
      archivePruned: false,
      skippedReason: "localRoot missing or outside its physical boundary",
    };
  }

  const doneTaskCache = new Map<string, boolean>(),
    dispatchResult = archiveSettledDispatchStreams({
      rootDir: layout.rootDir,
      ownedLocalRoot,
      projection: input.projection,
      owner: dispatchOwnerForNode(input.ownerNodeId),
      recoverySet: new Set(input.recoveryDispatchIds ?? []),
      liveRuntimeSessionIds: input.liveRuntimeSessionIds,
      doneTaskCache,
      batch: [...readLiveDispatchIds(ownedLocalRoot)]
        .filter((id): id is string => id !== null)
        .slice(0, Math.max(1, input.maxDispatches ?? DISPATCH_LIFECYCLE_PAGE_LIMIT)),
      compactArchived: true,
    });
  const steps = sweepLocalRootStorage(layout.rootDir, ownedLocalRoot, input, doneTaskCache);
  let sweep = steps.next();
  while (!sweep.done) sweep = steps.next();
  return {
    ...sweep.value,
    archivedDispatches: dispatchResult.archived,
    skippedReason: dispatchResult.skippedReason ?? sweep.value.skippedReason,
  };
}

type StorageSweepInput = Pick<
  Parameters<typeof reclaimLocalRootStorage>[0],
  "projection" | "retention" | "nowMs" | "recoveryDispatchIds"
>;

function* sweepLocalRootStorage(
  rootDir: string,
  ownedLocalRoot: string,
  input: StorageSweepInput,
  doneTaskCache: Map<string, boolean>,
  canDeleteArchive?: (factWatermark: number) => boolean,
): Generator<void, Omit<LocalRootReclaimResult, "archivedDispatches">> {
  const removedOrphanSidecars = yield* pruneOrphanEvidenceSidecars(rootDir, ownedLocalRoot);
  const removedHandoffRollouts = yield* pruneRetiredHandoffRollouts(
    rootDir,
    ownedLocalRoot,
    input.projection,
    doneTaskCache,
  );
  const removedStaleCacheFiles = pruneStaleDerivedFiles(ownedLocalRoot);

  let archivePruned = false,
    skippedReason: string | null = null;
  const ownedDispatchesDir = resolveOwnedDirectory(ownedLocalRoot, "runtime", "dispatches");
  if (ownedDispatchesDir === null || ownedSubdirectoryOrAbsent(ownedDispatchesDir, "archive") !== null) {
    const facts = tryReadFactEvidenceSources(input.projection);
    if (facts.status === "ready") {
      yield* pruneDispatchStreamArchiveSteps(
        rootDir,
        input.retention,
        facts.sources,
        input.nowMs ?? Date.now(),
        input.recoveryDispatchIds ?? [],
        () => facts.isReady() && (canDeleteArchive === undefined || canDeleteArchive(facts.watermark)),
      );
      if (facts.isReady()) archivePruned = true;
      else skippedReason = "fact projection changed during evidence scan";
    } else {
      skippedReason = "fact projection pending";
    }
  }

  return { removedOrphanSidecars, removedHandoffRollouts, removedStaleCacheFiles, archivePruned, skippedReason };
}

/** Schedule post-adoption reclamation on the repository writer, one bounded batch at a time. */
export function scheduleLocalRootReclamation(input: {
  readonly rootDir: string;
  readonly projection: () => StorageSweepInput["projection"] & Pick<TaskProjectionQueries, "readCut" | "readEventList">;
  readonly readRetention: () => DispatchArchiveRetention;
  readonly schedule: MaintenanceSchedule;
  readonly ownerNodeId?: string;
  readonly recoveryDispatchIds?: readonly string[];
  readonly maxDispatchesPerTurn?: number;
  readonly onComplete?: () => void;
}): void {
  const layout = resolveHarnessLayout(input.rootDir);
  const batchSize = Math.max(
    1,
    Math.min(input.maxDispatchesPerTurn ?? DISPATCH_LIFECYCLE_PAGE_LIMIT, DISPATCH_LIFECYCLE_PAGE_LIMIT),
  );
  function* reclaim(): Generator<void | "turn"> {
    const ownedLocalRoot = resolveOwnedLocalRoot(layout);
    if (ownedLocalRoot === null) return;
    const dispatchIds: string[] = [];
    // Snapshot candidates before moving files; renames can otherwise change the open directory cursor.
    for (const id of readLiveDispatchIds(ownedLocalRoot)) {
      if (id !== null) dispatchIds.push(id);
      yield;
    }
    const owner = dispatchOwnerForNode(input.ownerNodeId),
      recoverySet = new Set(input.recoveryDispatchIds ?? []),
      doneTaskCache = new Map<string, boolean>(),
      indexRemovals = new Map<string, Set<string>>();
    for (let offset = 0; offset < dispatchIds.length; offset += batchSize) {
      yield "turn";
      if (resolveOwnedLocalRoot(layout) !== ownedLocalRoot) return;
      const result = archiveSettledDispatchStreams({
        rootDir: layout.rootDir,
        ownedLocalRoot,
        projection: input.projection(),
        owner,
        recoverySet,
        doneTaskCache,
        batch: dispatchIds.slice(offset, offset + batchSize),
        compactArchived: false,
        indexRemovals,
      });
      if (result.skippedReason !== null) break;
    }
    if (dispatchIds.length > 0) yield "turn";
    for (const [taskId, ids] of indexRemovals) {
      removeDispatchLiveIndexEntries(layout.rootDir, taskId, ids);
      yield;
    }
    if (resolveOwnedLocalRoot(layout) !== ownedLocalRoot) return;
    const projection = input.projection();
    let verifiedThrough = -1;
    yield* sweepLocalRootStorage(
      layout.rootDir,
      ownedLocalRoot,
      { projection, retention: input.readRetention(), recoveryDispatchIds: input.recoveryDispatchIds },
      doneTaskCache,
      (factWatermark) => {
        const cut = projection.readCut();
        if (cut.status !== "ready" || cut.watermark < factWatermark) return false;
        if (cut.watermark === factWatermark || cut.watermark === verifiedThrough) return true;
        // A normal write may advance the cut. A newer recorded Fact invalidates the protection
        // snapshot, so end this pass before deleting against a stale set of references.
        const newest = projection.readEventList({
          type: evidenceCreationEvent,
          limit: storageReadPolicy.defaultValue.pageSizes.one,
        }).rows[0];
        if (newest && newest.revision > factWatermark) return false;
        verifiedThrough = cut.watermark;
        return true;
      },
    );
  }
  scheduleMaintenance(input.schedule, reclaim(), batchSize, input.onComplete);
}

function* readLiveDispatchIds(ownedLocalRoot: string): Generator<string | null> {
  const directory = resolveOwnedDirectory(ownedLocalRoot, "runtime", "dispatches");
  if (directory === null) return;
  for (const entry of directoryEntries(directory))
    yield entry.isFile() && dispatchFilePattern.test(entry.name) ? entry.name.slice(0, -6) : null;
}

function archiveSettledDispatchStreams(input: {
  readonly rootDir: string;
  readonly ownedLocalRoot: string;
  readonly projection: Pick<TaskProjectionQueries, "read" | "readDispatchLifecycle">;
  readonly owner: string;
  readonly recoverySet: ReadonlySet<string>;
  readonly liveRuntimeSessionIds?: ReadonlySet<string>;
  readonly doneTaskCache: Map<string, boolean>;
  readonly batch: readonly string[];
  readonly compactArchived: boolean;
  readonly indexRemovals?: Map<string, Set<string>>;
}): { readonly archived: number; readonly skippedReason: string | null } {
  const ownedDispatchesDir = resolveOwnedDirectory(input.ownedLocalRoot, "runtime", "dispatches");
  if (ownedDispatchesDir === null) return { archived: 0, skippedReason: null };
  if (
    ownedSubdirectoryOrAbsent(ownedDispatchesDir, "archive") === null ||
    ownedSubdirectoryOrAbsent(ownedDispatchesDir, "live-index") === null
  )
    return { archived: 0, skippedReason: "dispatch subdirectory boundary check failed" };

  const batch = input.batch;
  const viewsById = new Map<string, DispatchLifecycleView>();
  for (let offset = 0; offset < batch.length; offset += DISPATCH_LIFECYCLE_PAGE_LIMIT) {
    const page = input.projection.readDispatchLifecycle({
      by: "dispatch",
      dispatchIds: batch.slice(offset, offset + DISPATCH_LIFECYCLE_PAGE_LIMIT),
    });
    if (page.status !== "ready") return { archived: 0, skippedReason: "dispatch lifecycle projection pending" };
    for (const row of page.rows) viewsById.set(row.attempt.dispatchId, row);
  }

  const toArchive: string[] = [];
  for (const dispatchId of batch) {
    if (input.recoverySet.has(dispatchId) || !readOwnedRegularFileStat(ownedDispatchesDir, `${dispatchId}.jsonl`))
      continue;
    const view = viewsById.get(dispatchId);
    // Only the lifecycle owns node and stop proof. A legacy terminal transcript by itself
    // cannot establish that the attempt is no longer recoverable or still running.
    if (!view?.attempt.fence.verified || view.attempt.fence.owner !== input.owner) continue;
    if (input.liveRuntimeSessionIds?.has(view.attempt.runtimeSessionId) || view.policy.processAlive) continue;
    const stopProven = view.attempt.stopProof === "proven_stopped";
    if (!view.policy.attemptSettled || !stopProven) continue;
    const groupFinal =
      view.policy.groupSettled &&
      (!view.policy.successorAdmissible ||
        (view.attempt.task !== null &&
          isTaskIrreversiblyDoneCached(input.projection, view.attempt.task.taskId, input.doneTaskCache)));
    if (groupFinal) toArchive.push(dispatchId);
  }

  const archived =
    toArchive.length === 0
      ? 0
      : archiveDispatchStreams(input.rootDir, toArchive, {
          compact: input.compactArchived,
          indexRemovals: input.indexRemovals,
        }).length;
  return { archived, skippedReason: null };
}

function* pruneOrphanEvidenceSidecars(rootDir: string, ownedLocalRoot: string): Generator<void, number> {
  const directory = resolveOwnedDirectory(ownedLocalRoot, "runtime", "dispatches");
  if (directory === null) return 0;
  let removed = 0;
  for (const entry of directoryEntries(directory)) {
    if (resolveOwnedDirectory(ownedLocalRoot, "runtime", "dispatches") !== directory) return removed;
    const archive = ownedSubdirectoryOrAbsent(directory, "archive");
    if (archive === null) return removed;
    const match = evidenceSidecarPattern.exec(entry.name);
    if (entry.isFile() && match && readOwnedRegularFileStat(directory, entry.name)) {
      const dispatchId = `dispatch_${match[1]}`,
        stream = `${dispatchId}.jsonl`;
      if (
        !readOwnedRegularFileStat(directory, stream) &&
        (archive === "absent" || !readOwnedRegularFileStat(archive, stream)) &&
        readDispatchEvidenceState(rootDir, dispatchId) !== "pending"
      ) {
        removeDispatchEvidenceState(rootDir, dispatchId);
        removed += 1;
      }
    }
    yield;
  }
  return removed;
}

function* pruneRetiredHandoffRollouts(
  rootDir: string,
  ownedLocalRoot: string,
  projection: Pick<TaskProjectionQueries, "read" | "readRuntimeDispatchByResumeSource">,
  doneTaskCache: Map<string, boolean>,
): Generator<void, number> {
  const ownedHandoffsRoot = resolveOwnedDirectory(ownedLocalRoot, "runtime-handoffs");
  if (ownedHandoffsRoot === null) return 0;
  let removed = 0;
  for (const entry of directoryEntries(ownedHandoffsRoot)) {
    if (resolveOwnedDirectory(ownedLocalRoot, "runtime-handoffs") !== ownedHandoffsRoot) return removed;
    if (entry.isDirectory() && dispatchIdPattern.test(entry.name)) {
      const directory = resolveOwnedDirectory(ownedHandoffsRoot, entry.name);
      const rollout = directory && readOwnedRegularFileStat(directory, "rollout.jsonl");
      if (rollout && readOwnedRegularFileStat(directory, "checkpoint.json")) {
        const checkpoint = readHandoffCheckpoint(rootDir, entry.name);
        if (checkpoint && reclaimableHandoffRolloutReason(checkpoint, projection, doneTaskCache) !== null) {
          removeFileDurably(rollout.path);
          removed += 1;
        }
      }
    }
    yield;
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
    const realDir = realpathSync(target);
    if (!isStrictRealChild(ownedLocalRoot, realDir)) continue;
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
    const realDir = realpathSync(current);
    if (realDir !== ownedLocalRoot && !isStrictRealChild(ownedLocalRoot, realDir)) continue;
    for (const name of readdirSync(realDir)) stack.push(path.join(realDir, name));
  }
  return { bytes, files };
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

function toPosix(relative: string): string {
  return relative.split(path.sep).join("/");
}
