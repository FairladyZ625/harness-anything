import type { WorkIndexRead } from "../../api/renderer-dto.ts";
import type { EventEntry, TaskRow } from "./types.ts";

export interface WorkGroup {
  readonly task: TaskRow;
  descendants: number;
  leaves: number;
  counts: Record<string, number>;
  activity: EventEntry | null;
}

/** task-adapter emits exactly execution/review/consent/code-doc/gate lifecycle events. */
function latestActivity(task: TaskRow): WorkGroup["activity"] {
  return (task.events ?? []).reduce<WorkGroup["activity"]>(
    (latest, event) => (!latest || event.at > latest.at ? event : latest),
    null,
  );
}

/**
 * One cut, one parent index: the works are the daemon's (`TaskRow.workId` names the task itself);
 * root activity participates; only descendant leaves count.
 */
export function collectWork(tasks: readonly TaskRow[]): { groups: WorkGroup[]; isolated: TaskRow[] } {
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const parents = new Set(tasks.flatMap((task) => (task.parentTaskId ? [task.parentTaskId] : [])));
  const groups = new Map<string, WorkGroup>();
  for (const task of tasks) {
    if (task.workId === task.taskId) {
      groups.set(task.taskId, { task, descendants: 0, leaves: 0, counts: {}, activity: null });
    }
  }
  for (const task of tasks) {
    const activity = latestActivity(task);
    const leaf = !parents.has(task.taskId);
    const seen = new Set<string>();
    let current: TaskRow | undefined = task;
    while (current && !seen.has(current.taskId)) {
      seen.add(current.taskId);
      const group = groups.get(current.taskId);
      if (group) {
        if (activity && (!group.activity || activity.at > group.activity.at)) group.activity = activity;
        if (current !== task) {
          group.descendants++;
          if (leaf) {
            group.leaves++;
            const status = task.canonicalStatus ?? "unknown";
            group.counts[status] = (group.counts[status] ?? 0) + 1;
          }
        }
      }
      current = current.parentTaskId ? byId.get(current.parentTaskId) : undefined;
    }
  }
  return {
    groups: [...groups.values()].sort(
      (a, b) =>
        Number(Boolean(b.activity)) - Number(Boolean(a.activity)) ||
        (b.activity?.at ?? b.task.createdAt ?? "").localeCompare(a.activity?.at ?? a.task.createdAt ?? "") ||
        a.task.taskId.localeCompare(b.task.taskId),
    ),
    isolated: tasks
      .filter((task) => !task.parentTaskId && !groups.has(task.taskId))
      .sort((a, b) => b.lastKnownAt.localeCompare(a.lastKnownAt) || a.taskId.localeCompare(b.taskId)),
  };
}

export interface WorkRef {
  readonly taskId: string;
  readonly title: string;
}

export interface WorkIndex {
  /** A root `ha work list --all` names: declared work, or a top-level task with children. */
  readonly isWorkRoot: (taskId: string) => boolean;
  /** The work a task belongs to (a root belongs to its own work); null for a task in no work. */
  readonly workOf: (taskId: string) => WorkRef | null;
}

export const NO_WORKS: WorkIndex = { isWorkRoot: () => false, workOf: () => null };

/** Lookups over the daemon work index (`repo.works.index`); the GUI holds no work rule of its own. */
export function workIndexOf(read: WorkIndexRead | undefined): WorkIndex {
  if (read === undefined) return NO_WORKS;
  const roots = new Set<string>();
  const owner = new Map<string, WorkRef>();
  for (const work of read.works) {
    const ref = { taskId: work.taskId, title: work.title };
    roots.add(work.taskId);
    owner.set(work.taskId, ref);
    for (const taskId of work.memberTaskIds) owner.set(taskId, ref);
  }
  return { isWorkRoot: (taskId) => roots.has(taskId), workOf: (taskId) => owner.get(taskId) ?? null };
}
