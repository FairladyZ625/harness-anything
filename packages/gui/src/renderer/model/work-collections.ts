import type { AgendaAttentionItem, WorkIndexRead } from "../../api/renderer-dto.ts";
import type { EventEntry, TaskRow } from "./types.ts";

export interface WorkGroup {
  readonly task: TaskRow;
  descendants: number;
  leaves: number;
  counts: Record<string, number>;
  activity: EventEntry | null;
  /** 后代任务(不含根),搜索按任务标题命中时从这里找。 */
  members: TaskRow[];
  /** 根与全部后代里最新的 lastKnownAt(含生命周期活动):「24 小时内在动」与停滞判它。 */
  lastChangeAt: string;
  /** 根与全部后代里持有执行租约的任务数(在跑 agent)。 */
  live: number;
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
      groups.set(task.taskId, {
        task,
        descendants: 0,
        leaves: 0,
        counts: {},
        activity: null,
        members: [],
        lastChangeAt: task.lastKnownAt,
        live: task.activeExecutionId !== undefined ? 1 : 0,
      });
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
        if (task.lastKnownAt > group.lastChangeAt) group.lastChangeAt = task.lastKnownAt;
        if (activity && activity.at > group.lastChangeAt) group.lastChangeAt = activity.at;
        if (task.activeExecutionId !== undefined) group.live += 1;
        if (current !== task) {
          group.descendants++;
          group.members.push(task);
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

/** 一个工作的注意力条目切片(S1 议程读面 attentionItems 按 workTaskId 归组)。 */
export interface WorkAttention {
  /** region=mine(等你处理)条目,daemon 已按分数降序。 */
  readonly mine: readonly AgendaAttentionItem[];
  /** region=stuck(阻塞/停滞)条目。 */
  readonly stuck: readonly AgendaAttentionItem[];
  /** 本工作全部条目的最高注意力分;排序与总览同一序。 */
  readonly score: number;
}

/** 条目按 workTaskId 归组;不在任何工作上的条目(workTaskId=null)不进表。 */
export function attentionByWork(items: readonly AgendaAttentionItem[]): Map<string, WorkAttention> {
  const byWork = new Map<string, { mine: AgendaAttentionItem[]; stuck: AgendaAttentionItem[] }>();
  for (const item of items) {
    if (item.workTaskId === null) continue;
    const bucket = byWork.get(item.workTaskId) ?? { mine: [], stuck: [] };
    bucket[item.region].push(item);
    byWork.set(item.workTaskId, bucket);
  }
  return new Map(
    [...byWork].map(([workTaskId, { mine, stuck }]) => [
      workTaskId,
      { mine, stuck, score: Math.max(...[...mine, ...stuck].map(({ attention }) => attention.score)) },
    ]),
  );
}

export interface WorkHealth {
  readonly mine: readonly AgendaAttentionItem[];
  readonly score: number;
  readonly blocked: boolean;
  readonly stale: boolean;
  readonly moving: boolean;
  readonly finished: boolean;
  /** 默认筛选「需要关注」:有事等你、有阻塞、停滞或 24 小时内有变化。 */
  readonly needs: boolean;
}

const DAY_MS = 86_400_000;

/** 一行健康摘要的判据(原型 v1/v4 的 works 区域):停滞看根 active 且 7 天没变化,或议程里有停滞条目。 */
export function workHealth(group: WorkGroup, attention: WorkAttention | undefined, now: number): WorkHealth {
  const mine = attention?.mine ?? [];
  const blocked =
    (group.counts.blocked ?? 0) > 0 ||
    group.task.canonicalStatus === "blocked" ||
    (attention?.stuck.some(({ kind }) => kind === "blocked") ?? false);
  const stale =
    (group.task.canonicalStatus === "active" && Date.parse(group.lastChangeAt) < now - 7 * DAY_MS) ||
    (attention?.stuck.some(({ kind }) => kind === "stalled") ?? false);
  const moving = Date.parse(group.lastChangeAt) >= now - DAY_MS || group.live > 0;
  const open =
    (group.counts.planned ?? 0) +
    (group.counts.active ?? 0) +
    (group.counts.submitted ?? 0) +
    (group.counts.in_review ?? 0) +
    (group.counts.blocked ?? 0);
  return {
    mine,
    score: attention?.score ?? 0,
    blocked,
    stale,
    moving,
    finished: group.leaves > 0 && open === 0,
    needs: mine.length > 0 || blocked || stale || moving,
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
