import type { TaskClass } from "./task.ts";

export const MAX_TRACKED_TASKS = 128;
export const MAX_PINNED_WORKS = 256;
export const MAX_BLOCKED_PINNED = 64;
export const MAX_ARCHIVED_TASK_INDEX = 1024;
export const MAX_WORK_COUNTERS = 320;

export type ArchivedTaskBucket = "d" | "b" | "c" | "a";

export interface DossierTaskRecord {
  readonly taskId: string;
  readonly title: string;
  readonly taskClass: TaskClass;
  readonly status: string;
  readonly parentTaskId: string | null;
  readonly packagePath?: string;
  readonly surfaces: readonly string[];
  readonly workspaceRevision: number;
  readonly occurredAt: string;
  readonly actorLabel: string;
  readonly reason?: string;
  readonly countsIncomplete?: boolean;
}

export interface DossierWorkCounter {
  readonly archivedTotal: number;
  readonly archivedDone: number;
  readonly archivedBlocked: number;
  readonly archivedActive: number;
  readonly archivedCancelled: number;
  readonly latestRevision: number;
  readonly title?: string;
  readonly packagePath?: string;
  readonly countsIncomplete?: boolean;
  readonly archivedTaskStates?: Readonly<Record<string, ArchivedTaskBucket>>;
}

function clipOneLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

export function resolveRootWorkId(
  task: Pick<DossierTaskRecord, "taskId" | "parentTaskId">,
  taskMap: Readonly<Record<string, DossierTaskRecord>>,
  workCounters?: Readonly<Record<string, DossierWorkCounter>>,
): string | null {
  if (!task.parentTaskId) return null;
  let cursor: string | null = task.parentTaskId;
  const visited = new Set<string>([task.taskId]);
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const parent: DossierTaskRecord | undefined = taskMap[cursor];
    if (!parent) {
      if (workCounters) {
        for (const [workId, counter] of Object.entries(workCounters)) {
          if (counter.archivedTaskStates?.[cursor]) return workId;
        }
      }
      return cursor;
    }
    if (parent.taskClass === "work" || parent.parentTaskId === null) {
      return cursor;
    }
    cursor = parent.parentTaskId;
  }
  return null;
}

function bucketForStatus(status: string): ArchivedTaskBucket {
  return status === "done" ? "d" : status === "blocked" ? "b" : status === "cancelled" ? "c" : "a";
}

export function summarizeArchivedStates(states: Readonly<Record<string, ArchivedTaskBucket>> | undefined): {
  readonly archivedTotal: number;
  readonly archivedDone: number;
  readonly archivedBlocked: number;
  readonly archivedActive: number;
  readonly archivedCancelled: number;
} {
  let archivedTotal = 0;
  let archivedDone = 0;
  let archivedBlocked = 0;
  let archivedActive = 0;
  let archivedCancelled = 0;
  if (states) {
    for (const bucket of Object.values(states)) {
      archivedTotal += 1;
      if (bucket === "d") archivedDone += 1;
      else if (bucket === "b") archivedBlocked += 1;
      else if (bucket === "c") archivedCancelled += 1;
      else archivedActive += 1;
    }
  }
  return { archivedTotal, archivedDone, archivedBlocked, archivedActive, archivedCancelled };
}

export function trimArchivedTaskStates(
  counter: DossierWorkCounter,
  maxIndex: number,
): { readonly counter: DossierWorkCounter; readonly blockedIndexDropped: boolean } {
  const entries = Object.entries(counter.archivedTaskStates ?? {});
  const unindexedLegacy = counter.archivedTaskStates === undefined && counter.archivedTotal > 0;
  if (entries.length <= maxIndex && !unindexedLegacy) {
    const exact = summarizeArchivedStates(counter.archivedTaskStates);
    return {
      counter: { ...counter, ...exact },
      blockedIndexDropped: false,
    };
  }
  const dropped = entries.length > maxIndex ? entries.slice(0, entries.length - maxIndex) : [];
  const kept = entries.length > maxIndex ? entries.slice(entries.length - maxIndex) : entries;
  const keptRecord = kept.length > 0 ? Object.fromEntries(kept) : undefined;
  const exact = summarizeArchivedStates(keptRecord);
  const { archivedTaskStates: _prev, ...rest } = counter;
  return {
    counter: {
      ...rest,
      ...exact,
      countsIncomplete: true,
      ...(keptRecord ? { archivedTaskStates: keptRecord } : {}),
    },
    blockedIndexDropped:
      (unindexedLegacy && counter.archivedBlocked > 0) || dropped.some(([, bucket]) => bucket === "b"),
  };
}

function incrementWorkCounter(
  workCounters: Record<string, DossierWorkCounter>,
  workId: string,
  task: DossierTaskRecord,
  maxArchivedTaskIndex = MAX_ARCHIVED_TASK_INDEX,
): boolean {
  const current = workCounters[workId];
  const nextBucket = bucketForStatus(task.status);
  const orderedEntries = Object.entries(current?.archivedTaskStates ?? {}).filter(([id]) => id !== task.taskId);
  orderedEntries.push([task.taskId, nextBucket]);
  const nextStates = Object.fromEntries(orderedEntries);
  const trimmed = trimArchivedTaskStates(
    {
      archivedTotal: 0,
      archivedDone: 0,
      archivedBlocked: 0,
      archivedActive: 0,
      archivedCancelled: 0,
      ...(current ? current : {}),
      latestRevision: Math.max(current?.latestRevision ?? 0, task.workspaceRevision),
      archivedTaskStates: nextStates,
    },
    maxArchivedTaskIndex,
  );
  workCounters[workId] = trimmed.counter;
  return trimmed.blockedIndexDropped;
}

export function reclaimArchivedChildTask(
  taskId: string,
  workCounters: Record<string, DossierWorkCounter>,
): string | null {
  for (const [workId, counter] of Object.entries(workCounters)) {
    const bucket = counter.archivedTaskStates?.[taskId];
    if (!bucket) continue;
    const nextStates = { ...counter.archivedTaskStates };
    delete nextStates[taskId];
    const hasRemaining = Object.keys(nextStates).length > 0;
    const exact = summarizeArchivedStates(hasRemaining ? nextStates : undefined);
    const { archivedTaskStates: _prev, ...rest } = counter;
    workCounters[workId] = {
      ...rest,
      ...exact,
      ...(hasRemaining ? { archivedTaskStates: nextStates } : {}),
    };
    return workId;
  }
  return null;
}

export function pruneTasks(
  tasks: Record<string, DossierTaskRecord>,
  workCounters: Record<string, DossierWorkCounter>,
  maxPinnedWorks = MAX_PINNED_WORKS,
  maxTrackedTasks = MAX_TRACKED_TASKS,
  maxBlockedPinned = MAX_BLOCKED_PINNED,
  maxArchivedTaskIndex = MAX_ARCHIVED_TASK_INDEX,
): { readonly tasks: Record<string, DossierTaskRecord>; readonly blockedEvicted: boolean } {
  const all = Object.values(tasks);
  const works = all
    .filter((task) => task.taskClass === "work")
    .sort(
      (left, right) =>
        Math.max(right.workspaceRevision, workCounters[right.taskId]?.latestRevision ?? 0) -
          Math.max(left.workspaceRevision, workCounters[left.taskId]?.latestRevision ?? 0) ||
        left.taskId.localeCompare(right.taskId),
    );
  const blockedNonWorks = all
    .filter((task) => task.taskClass !== "work" && task.status === "blocked")
    .sort((left, right) => right.workspaceRevision - left.workspaceRevision || left.taskId.localeCompare(right.taskId));
  if (all.length <= maxTrackedTasks && works.length <= maxPinnedWorks && blockedNonWorks.length <= maxBlockedPinned) {
    return { tasks, blockedEvicted: false };
  }
  const keptWorks = works.slice(0, maxPinnedWorks);
  const evictedWorks = works.slice(maxPinnedWorks);
  const evictedWorkIds = new Set(evictedWorks.map((task) => task.taskId));
  let unindexedBlockedEvicted = evictedWorks.some((task) => task.status === "blocked");
  for (const evictedWork of evictedWorks) {
    const existingCounter = workCounters[evictedWork.taskId];
    const incomplete = Boolean(evictedWork.countsIncomplete || existingCounter?.countsIncomplete);
    const resolvedPath = evictedWork.packagePath ?? existingCounter?.packagePath;
    const trimmed = trimArchivedTaskStates(
      {
        archivedTotal: existingCounter?.archivedTotal ?? 0,
        archivedDone: existingCounter?.archivedDone ?? 0,
        archivedBlocked: existingCounter?.archivedBlocked ?? 0,
        archivedActive: existingCounter?.archivedActive ?? 0,
        archivedCancelled: existingCounter?.archivedCancelled ?? 0,
        latestRevision: Math.max(existingCounter?.latestRevision ?? 0, evictedWork.workspaceRevision),
        title: clipOneLine(evictedWork.title, 72),
        ...(resolvedPath ? { packagePath: resolvedPath } : {}),
        ...(incomplete ? { countsIncomplete: true } : {}),
        ...(existingCounter?.archivedTaskStates ? { archivedTaskStates: existingCounter.archivedTaskStates } : {}),
      },
      maxArchivedTaskIndex,
    );
    workCounters[evictedWork.taskId] = trimmed.counter;
    if (trimmed.blockedIndexDropped) unindexedBlockedEvicted = true;
  }
  const keptBlocked = blockedNonWorks.slice(0, maxBlockedPinned);
  const pinned = [...keptWorks, ...keptBlocked];
  const pinnedIds = new Set(pinned.map((task) => task.taskId));
  const candidates = all
    .filter((task) => !pinnedIds.has(task.taskId) && !evictedWorkIds.has(task.taskId))
    .sort((left, right) => {
      const leftTerminal = left.status === "done" || left.status === "cancelled" ? 1 : 0;
      const rightTerminal = right.status === "done" || right.status === "cancelled" ? 1 : 0;
      return leftTerminal - rightTerminal || right.workspaceRevision - left.workspaceRevision;
    });
  const keepCount = Math.max(0, maxTrackedTasks - pinned.length);
  const kept = candidates.slice(0, keepCount);
  const evicted = candidates.slice(keepCount);
  for (const task of evicted) {
    const rootWorkId = resolveRootWorkId(task, tasks, workCounters);
    if (rootWorkId) {
      if (incrementWorkCounter(workCounters, rootWorkId, task, maxArchivedTaskIndex)) {
        unindexedBlockedEvicted = true;
      }
    } else if (task.status === "blocked") {
      unindexedBlockedEvicted = true;
    }
  }
  return {
    tasks: Object.fromEntries([...pinned, ...kept].map((task) => [task.taskId, task])),
    blockedEvicted: unindexedBlockedEvicted,
  };
}

export function pruneByRevision<T extends { readonly workspaceRevision: number }>(
  map: Record<string, T>,
  maxItems: number,
): Record<string, T> {
  const entries = Object.entries(map);
  if (entries.length <= maxItems) return map;
  return Object.fromEntries(
    entries.sort((left, right) => right[1].workspaceRevision - left[1].workspaceRevision).slice(0, maxItems),
  );
}

export function pruneWorkCounters(
  counters: Record<string, DossierWorkCounter>,
  prunedTasks: Readonly<Record<string, DossierTaskRecord>>,
  priorTruncated: boolean,
  maxOrphanCounters = MAX_WORK_COUNTERS,
  maxArchivedTaskIndex = MAX_ARCHIVED_TASK_INDEX,
): {
  readonly counters: Record<string, DossierWorkCounter>;
  readonly truncated: boolean;
  readonly blockedDropped: boolean;
} {
  const survivingWorkIds = new Set<string>(Object.keys(prunedTasks));
  for (const task of Object.values(prunedTasks)) {
    const rootId = resolveRootWorkId(task, prunedTasks, counters);
    if (rootId) survivingWorkIds.add(rootId);
  }
  const pinnedEntries: [string, DossierWorkCounter][] = [];
  const orphanEntries: [string, DossierWorkCounter][] = [];
  let blockedIndexDropped = false;
  for (const [workId, counter] of Object.entries(counters)) {
    const trimmed = trimArchivedTaskStates(counter, maxArchivedTaskIndex);
    if (trimmed.blockedIndexDropped) blockedIndexDropped = true;
    if (survivingWorkIds.has(workId)) pinnedEntries.push([workId, trimmed.counter]);
    else orphanEntries.push([workId, trimmed.counter]);
  }
  orphanEntries.sort((left, right) => right[1].latestRevision - left[1].latestRevision);
  const dropped = orphanEntries.slice(maxOrphanCounters);
  const truncated =
    priorTruncated || dropped.some(([, counter]) => counter.archivedTotal > 0 || Boolean(counter.countsIncomplete));
  const blockedDropped = blockedIndexDropped || dropped.some(([, counter]) => counter.archivedBlocked > 0);
  return {
    counters: Object.fromEntries([...pinnedEntries, ...orphanEntries.slice(0, maxOrphanCounters)]),
    truncated,
    blockedDropped,
  };
}
