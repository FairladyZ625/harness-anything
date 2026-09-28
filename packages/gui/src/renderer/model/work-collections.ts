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

/** One cut, one parent index: root activity participates; only descendant leaves count. */
export function collectWork(tasks: readonly TaskRow[]): { groups: WorkGroup[]; isolated: TaskRow[] } {
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const parents = new Set(tasks.flatMap((task) => (task.parentTaskId ? [task.parentTaskId] : [])));
  const groups = new Map<string, WorkGroup>();
  for (const task of tasks) {
    if (parents.has(task.taskId) || task.taskClass === "work") {
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

export interface WorkIndex {
  /** Declared (taskClass=work) or a top-level task with children: `ha work list`'s root rule. */
  readonly isWorkRoot: (taskId: string) => boolean;
  /** The work a child belongs to: nearest declared-work ancestor, else topmost ancestor; null for a top-level task. */
  readonly workOf: (taskId: string) => TaskRow | null;
}

/**
 * The daemon's two work rules (work-read.ts, workspace-scope-read.ts#workRootOf) over the same-cut task
 * rows the GUI already holds. The incremental task read cannot carry them per row: both depend on other rows.
 */
export function workIndexOf(tasks: readonly TaskRow[]): WorkIndex {
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const parents = new Set(tasks.flatMap((task) => (task.parentTaskId ? [task.parentTaskId] : [])));
  return {
    isWorkRoot: (taskId) => {
      const task = byId.get(taskId);
      return task !== undefined && (task.taskClass === "work" || (!task.parentTaskId && parents.has(taskId)));
    },
    workOf: (taskId) => {
      let work: TaskRow | null = null;
      const seen = new Set<string>();
      for (let id = byId.get(taskId)?.parentTaskId; id && !seen.has(id); ) {
        seen.add(id);
        const task = byId.get(id);
        if (!task) break;
        work = task;
        id = task.taskClass === "work" ? undefined : task.parentTaskId;
      }
      return work;
    },
  };
}
