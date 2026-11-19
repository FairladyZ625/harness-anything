import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  DISPATCH_LIFECYCLE_PAGE_LIMIT,
  isTerminalStatus,
  resolveHarnessLayout,
  type DispatchLifecycleView,
  type TaskProjectionQueries,
} from "@harness-anything/kernel";
import { removeFileDurably } from "../../../storage/src/durable-file.ts";
import { readDispatchEvidenceState, removeDispatchEvidenceState } from "./dispatch-evidence-state.ts";
import { archiveDispatchStream, readDispatchStreamSummary } from "./dispatch-stream.ts";
import {
  pruneDispatchStreamArchive,
  readFactEvidenceSources,
  type DispatchArchiveRetention,
} from "./dispatch-stream-archive.ts";
import { cachePurgeDerivedDirectories, cachePurgePreservedPaths } from "./repo-cache-purge.ts";

export type LocalRootEntryClass = "authoritative" | "derived" | "unrecognized";

export interface LocalRootStorageEntry {
  readonly name: string;
  readonly classification: LocalRootEntryClass;
  readonly bytes: number;
  readonly files: number;
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
  readonly removedRetiredDispatches: boolean;
  readonly archivePruned: boolean;
  readonly skippedReason: string | null;
}

const dispatchFilePattern = /^dispatch_([a-f0-9]{24})\.jsonl$/u;
const evidenceSidecarPattern = /^dispatch_([a-f0-9]{24})\.evidence-state\.json$/u;
const dispatchIdPattern = /^dispatch_[a-f0-9]{24}$/u;

const verificationCacheSuffixes = ["", "-wal", "-shm"] as const;

/**
 * Iterative O(entries) measurement of `layout.localRoot`, classified against the single
 * purge/preservation source of truth in `repo-cache-purge.ts`. Never follows symbolic links.
 */
export function measureLocalRootStorage(rootDir: string): LocalRootStorageReport {
  const layout = resolveHarnessLayout(rootDir),
    relativeLocalRoot = toPosix(path.relative(layout.rootDir, layout.localRoot) || "."),
    derivedRoots = new Set(cachePurgeDerivedDirectories.map((entry) => entry.split("/")[0]!)),
    preservedPrefix = `${relativeLocalRoot}/`,
    authoritativeRoots = new Set(
      cachePurgePreservedPaths(layout.rootDir)
        .filter((entry) => entry.startsWith(preservedPrefix))
        .map((entry) => entry.slice(preservedPrefix.length).split("/")[0]!),
    );
  const byClass: Record<LocalRootEntryClass, { bytes: number; files: number }> = {
    authoritative: { bytes: 0, files: 0 },
    derived: { bytes: 0, files: 0 },
    unrecognized: { bytes: 0, files: 0 },
  };
  if (!existsSync(layout.localRoot)) {
    return {
      schema: "doctor-storage/v1",
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
  for (const dirent of readdirSync(layout.localRoot, { withFileTypes: true })) {
    const classification: LocalRootEntryClass = derivedRoots.has(dirent.name)
      ? "derived"
      : authoritativeRoots.has(dirent.name)
        ? "authoritative"
        : "unrecognized";
    const stats = walkSize(path.join(layout.localRoot, dirent.name));
    byClass[classification].bytes += stats.bytes;
    byClass[classification].files += stats.files;
    entries.push({ name: dirent.name, classification, bytes: stats.bytes, files: stats.files });
  }
  entries.sort((left, right) => right.bytes - left.bytes || left.name.localeCompare(right.name));
  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0),
    totalFiles = entries.reduce((sum, entry) => sum + entry.files, 0);
  return {
    schema: "doctor-storage/v1",
    rootDir: layout.rootDir,
    localRoot: layout.localRoot,
    relativeLocalRoot,
    exists: true,
    totalBytes,
    totalFiles,
    byClass,
    entries,
    highlights: buildStorageHighlights(layout),
  };
}

/**
 * Reclaim settled/terminal runtime artifacts and leaked verification/legacy cache in O(N) time.
 * Never touches canonical `store/`, `wal/`, `store/imports/`, `pending` evidence, or in-flight
 * runtime streams, and fails closed when projection reads are pending.
 */
export function reclaimLocalRootStorage(input: {
  readonly rootDir: string;
  readonly projection: Pick<
    TaskProjectionQueries,
    "read" | "readDispatchLifecycle" | "readRuntimeDispatchByResumeSource" | "searchFacts"
  >;
  readonly retention: DispatchArchiveRetention;
  readonly nowMs?: number;
  readonly recoveryDispatchIds?: readonly string[];
  readonly liveRuntimeSessionIds?: ReadonlySet<string>;
}): LocalRootReclaimResult {
  const layout = resolveHarnessLayout(input.rootDir),
    recoverySet = new Set(input.recoveryDispatchIds ?? []);
  const dispatchResult = archiveSettledDispatchStreams(
    layout.rootDir,
    layout.localRoot,
    input.projection,
    recoverySet,
    input.liveRuntimeSessionIds,
  );
  const removedOrphanSidecars = pruneOrphanEvidenceSidecars(layout.rootDir, layout.localRoot);
  const removedHandoffRollouts = pruneTerminalHandoffRollouts(layout.localRoot, input.projection);
  const { removedStaleCacheFiles, removedRetiredDispatches } = pruneStaleDerivedFiles(layout);

  let archivePruned = false;
  let skippedReason: string | null = dispatchResult.skippedReason;
  const factProbe = input.projection.searchFacts({});
  if (factProbe.status !== "ready") {
    skippedReason = skippedReason ?? "fact projection pending";
  } else {
    const evidenceSources = readFactEvidenceSources(input.projection);
    pruneDispatchStreamArchive(
      layout.rootDir,
      input.retention,
      evidenceSources,
      input.nowMs ?? Date.now(),
      input.recoveryDispatchIds ?? [],
    );
    archivePruned = true;
  }

  return {
    archivedDispatches: dispatchResult.archived,
    removedOrphanSidecars,
    removedHandoffRollouts,
    removedStaleCacheFiles,
    removedRetiredDispatches,
    archivePruned,
    skippedReason,
  };
}

function archiveSettledDispatchStreams(
  rootDir: string,
  localRoot: string,
  projection: Pick<TaskProjectionQueries, "read" | "readDispatchLifecycle">,
  recoverySet: ReadonlySet<string>,
  liveRuntimeSessionIds?: ReadonlySet<string>,
): { readonly archived: number; readonly skippedReason: string | null } {
  const dispatchesRoot = path.join(localRoot, "runtime", "dispatches");
  if (!statSync(dispatchesRoot, { throwIfNoEntry: false })?.isDirectory()) return { archived: 0, skippedReason: null };
  const liveIds = readdirSync(dispatchesRoot)
    .map((name) => dispatchFilePattern.exec(name)?.[1])
    .filter((id): id is string => id !== undefined)
    .map((hex) => `dispatch_${hex}`);
  if (liveIds.length === 0) return { archived: 0, skippedReason: null };

  const viewsById = new Map<string, DispatchLifecycleView>();
  for (let offset = 0; offset < liveIds.length; offset += DISPATCH_LIFECYCLE_PAGE_LIMIT) {
    const page = projection.readDispatchLifecycle({
      by: "dispatch",
      dispatchIds: liveIds.slice(offset, offset + DISPATCH_LIFECYCLE_PAGE_LIMIT),
    });
    if (page.status !== "ready") return { archived: 0, skippedReason: "dispatch lifecycle projection pending" };
    for (const row of page.rows) viewsById.set(row.attempt.dispatchId, row);
  }

  const terminalTaskCache = new Map<string, boolean>();
  let archived = 0;
  for (const dispatchId of liveIds) {
    if (recoverySet.has(dispatchId)) continue;
    const view = viewsById.get(dispatchId);
    if (view !== undefined) {
      if (liveRuntimeSessionIds?.has(view.attempt.runtimeSessionId) || view.policy.processAlive) continue;
      const settled =
        (view.policy.groupSettled && !view.policy.successorAdmissible) ||
        (view.policy.attemptSettled &&
          view.attempt.stopProof === "proven_stopped" &&
          view.attempt.task !== null &&
          isTaskTerminalCached(projection, view.attempt.task.taskId, terminalTaskCache));
      if (!settled) continue;
      archiveDispatchStream(rootDir, dispatchId);
      if (!existsSync(path.join(dispatchesRoot, `${dispatchId}.jsonl`))) archived += 1;
      continue;
    }
    const summary = readDispatchStreamSummary(rootDir, dispatchId);
    if (!summary || liveRuntimeSessionIds?.has(summary.header.runtimeSessionId)) continue;
    if (summary.terminalOutcome === null || summary.header.taskId === null) continue;
    if (!isTaskTerminalCached(projection, summary.header.taskId, terminalTaskCache)) continue;
    archiveDispatchStream(rootDir, dispatchId);
    if (!existsSync(path.join(dispatchesRoot, `${dispatchId}.jsonl`))) archived += 1;
  }
  return { archived, skippedReason: null };
}

function pruneOrphanEvidenceSidecars(rootDir: string, localRoot: string): number {
  const dispatchesRoot = path.join(localRoot, "runtime", "dispatches");
  if (!statSync(dispatchesRoot, { throwIfNoEntry: false })?.isDirectory()) return 0;
  const archiveRoot = path.join(dispatchesRoot, "archive");
  const presentStreams = new Set<string>();
  for (const directory of [dispatchesRoot, archiveRoot]) {
    if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) continue;
    for (const name of readdirSync(directory)) {
      const match = dispatchFilePattern.exec(name);
      if (match) presentStreams.add(`dispatch_${match[1]}`);
    }
  }
  let removed = 0;
  for (const name of readdirSync(dispatchesRoot)) {
    const match = evidenceSidecarPattern.exec(name);
    if (!match) continue;
    const dispatchId = `dispatch_${match[1]}`;
    if (presentStreams.has(dispatchId)) continue;
    if (readDispatchEvidenceState(rootDir, dispatchId) === "pending") continue;
    removeDispatchEvidenceState(rootDir, dispatchId);
    removed += 1;
  }
  return removed;
}

function pruneTerminalHandoffRollouts(
  localRoot: string,
  projection: Pick<TaskProjectionQueries, "read" | "readRuntimeDispatchByResumeSource">,
): number {
  const handoffsRoot = path.join(localRoot, "runtime-handoffs");
  if (!statSync(handoffsRoot, { throwIfNoEntry: false })?.isDirectory()) return 0;
  const terminalTaskCache = new Map<string, boolean>();
  let removed = 0;
  for (const entry of readdirSync(handoffsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !dispatchIdPattern.test(entry.name)) continue;
    const dir = path.join(handoffsRoot, entry.name),
      rolloutPath = path.join(dir, "rollout.jsonl"),
      checkpointPath = path.join(dir, "checkpoint.json");
    if (!statSync(rolloutPath, { throwIfNoEntry: false })?.isFile()) continue;
    if (!statSync(checkpointPath, { throwIfNoEntry: false })?.isFile()) continue;
    const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8")) as {
      readonly taskId?: unknown;
      readonly revokedAt?: unknown;
    };
    const revoked = typeof checkpoint.revokedAt === "string" && checkpoint.revokedAt.length > 0;
    const resumed = projection.readRuntimeDispatchByResumeSource(entry.name) !== null;
    const terminalTask =
      typeof checkpoint.taskId === "string" && isTaskTerminalCached(projection, checkpoint.taskId, terminalTaskCache);
    if (!revoked && !resumed && !terminalTask) continue;
    removeFileDurably(rolloutPath);
    removed += 1;
  }
  return removed;
}

function pruneStaleDerivedFiles(layout: ReturnType<typeof resolveHarnessLayout>): {
  readonly removedStaleCacheFiles: number;
  readonly removedRetiredDispatches: boolean;
} {
  let removedStaleCacheFiles = 0;
  const removeWithSidecars = (basePath: string) => {
    for (const suffix of verificationCacheSuffixes) {
      const target = `${basePath}${suffix}`;
      if (!existsSync(target)) continue;
      removeFileDurably(target);
      removedStaleCacheFiles += 1;
    }
  };
  removeWithSidecars(path.join(layout.cacheRoot, "completion-conversion-verification.sqlite"));
  if (existsSync(layout.taskProjectionPath)) removeWithSidecars(layout.projectionPath);

  const retiredDispatches = path.join(layout.localRoot, "runtime", "retired-dispatches");
  let removedRetiredDispatches = false;
  if (existsSync(retiredDispatches)) {
    removedRetiredDispatches = removeFilesInTreeDurably(retiredDispatches) > 0;
  }
  return { removedStaleCacheFiles, removedRetiredDispatches };
}

function removeFilesInTreeDurably(rootTarget: string): number {
  const stack = [rootTarget];
  let removed = 0;
  while (stack.length > 0) {
    const current = stack.pop()!,
      stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined) continue;
    if (stat.isSymbolicLink() || stat.isFile()) {
      removeFileDurably(current);
      removed += 1;
    } else if (stat.isDirectory()) {
      for (const name of readdirSync(current)) stack.push(path.join(current, name));
    }
  }
  return removed;
}

function isTaskTerminalCached(
  projection: Pick<TaskProjectionQueries, "read">,
  taskId: string,
  cache: Map<string, boolean>,
): boolean {
  const cached = cache.get(taskId);
  if (cached !== undefined) return cached;
  const read = projection.read(taskId);
  const terminal =
    read.status === "ready" && read.snapshot.task !== null && isTerminalStatus(read.snapshot.task.status);
  cache.set(taskId, terminal);
  return terminal;
}

function buildStorageHighlights(layout: ReturnType<typeof resolveHarnessLayout>): readonly LocalRootStorageHighlight[] {
  const candidates: {
    readonly path: string;
    readonly target: string;
    readonly classification: LocalRootStorageHighlight["classification"];
    readonly note: string;
  }[] = [
    {
      path: "store/generations",
      target: path.join(layout.localRoot, "store", "generations"),
      classification: "authoritative",
      note: "Canonical SQLite event ledger and content objects; never auto-reclaimed.",
    },
    {
      path: "store/retired",
      target: path.join(layout.localRoot, "store", "retired"),
      classification: "historical",
      note: "Retired pre-v3 SQLite generations kept after offline conversion; manual delete only after backup.",
    },
    {
      path: "store/imports",
      target: path.join(layout.localRoot, "store", "imports"),
      classification: "authoritative",
      note: "Imported legacy snapshot baseline; preserved.",
    },
    {
      path: "cache/task.sqlite",
      target: layout.taskProjectionPath,
      classification: "derived",
      note: "Active SQLite projection cache; rebuildable via ha daemon projection rebuild.",
    },
    {
      path: "cache/completion-conversion-verification.sqlite",
      target: path.join(layout.cacheRoot, "completion-conversion-verification.sqlite"),
      classification: "derived",
      note: "One-off conversion verification cache; safe to reclaim automatically.",
    },
    {
      path: "runtime/dispatches/archive",
      target: path.join(layout.localRoot, "runtime", "dispatches", "archive"),
      classification: "derived",
      note: "Compacted terminal dispatch streams; pruned by retentionDays/retentionBytes except Fact evidence.",
    },
    {
      path: "runtime/retired-dispatches",
      target: path.join(layout.localRoot, "runtime", "retired-dispatches"),
      classification: "derived",
      note: "Legacy pre-archive dispatch directory; safe to reclaim automatically.",
    },
    {
      path: "requests",
      target: path.join(layout.localRoot, "requests"),
      classification: "derived",
      note: "Daemon request observability log; size-rotated (4 MiB) with 7-day age pruning.",
    },
    {
      path: "runtime-handoffs",
      target: path.join(layout.localRoot, "runtime-handoffs"),
      classification: "unrecognized",
      note: "Cross-node handoff checkpoints and rollouts; rollout.jsonl is reclaimed once terminal/revoked/resumed.",
    },
  ];
  const highlights: LocalRootStorageHighlight[] = [];
  for (const candidate of candidates) {
    if (!existsSync(candidate.target)) continue;
    const stats = walkSize(candidate.target);
    highlights.push({
      path: candidate.path,
      classification: candidate.classification,
      bytes: stats.bytes,
      files: stats.files,
      note: candidate.note,
    });
  }
  return highlights;
}

function walkSize(rootTarget: string): { readonly bytes: number; readonly files: number } {
  const stack = [rootTarget];
  let bytes = 0;
  let files = 0;
  while (stack.length > 0) {
    const current = stack.pop()!,
      stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined) continue;
    if (stat.isSymbolicLink() || stat.isFile()) {
      bytes += stat.size;
      files += 1;
    } else if (stat.isDirectory()) {
      for (const name of readdirSync(current)) stack.push(path.join(current, name));
    }
  }
  return { bytes, files };
}

function toPosix(relative: string): string {
  return relative.split(path.sep).join("/");
}
