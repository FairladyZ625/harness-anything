import type { TaskRow } from "../model/types";

/**
 * 领地的「每个工作的进度」(老版领地视图的核心能力,rebuild 线丢失后在此找回)。
 *
 * 工作(dec_5F7E74F1)= 一个**根 task** 加它的 parentTaskId 子树:task 树沿 parentTaskId
 * 上溯,根即 rootTaskId。领地 task 分区按 rootTaskId 聚簇成工作块,每块带自己的状态
 * 构成与完成率。
 *
 * 构成与排序都读 daemon 投影的 `board`(dec_5B135F46 CH4):列由 `board.columnId` 给,
 * 块内顺序由 `board.rank` 给,renderer 不再自己把状态词分桶或排权重。
 * 诚实边界:所属工作无法确定的 task(父任务不在可见集合、或父链成环)显式归入
 * 「工作未知」块,只降权重排,不隐藏,也不猜它属于哪个工作。
 */

/** 内部哨兵:所属工作未知。渲染侧翻成 UNKNOWN_WORK_TITLE。 */
export const UNKNOWN_WORK = "__unknown_work__";
export const UNKNOWN_WORK_TITLE = "工作未知";

export interface ZoneProgress {
  total: number;
  /** 看板 terminal 列(kernel `terminalDomainStatuses`:done 与 cancelled)。 */
  terminal: number;
  open: number;
  blocked: number;
  inReview: number;
  /** 投影不给列的行(无 projected task):不计完成,但单列出来避免「消失」。 */
  unplaced: number;
  /** 完成率 = terminal / total,0..1。 */
  doneRatio: number;
  /** 该块是否是「工作未知」块(所属工作无法确定)。 */
  unknownWork: boolean;
}

const EMPTY_PROGRESS: ZoneProgress = {
  total: 0,
  terminal: 0,
  open: 0,
  blocked: 0,
  inReview: 0,
  unplaced: 0,
  doneRatio: 0,
  unknownWork: false,
};

/** 一组 task 的看板列构成 + 完成率。 */
export function deriveZoneProgress(tasks: ReadonlyArray<TaskRow>, unknownWork = false): ZoneProgress {
  if (tasks.length === 0) return { ...EMPTY_PROGRESS, unknownWork };
  const counts = { terminal: 0, open: 0, blocked: 0, in_review: 0 };
  let unplaced = 0;
  for (const task of tasks) {
    const columnId = task.board.columnId;
    if (columnId === null) unplaced += 1;
    else counts[columnId] += 1;
  }
  return {
    total: tasks.length,
    terminal: counts.terminal,
    open: counts.open,
    blocked: counts.blocked,
    inReview: counts.in_review,
    unplaced,
    doneRatio: counts.terminal / tasks.length,
    unknownWork,
  };
}

/**
 * zone 排序键(小的排前面)。承重排序:**有阻塞的工作最先看见,工作未知永远沉底**。
 *   0 有阻塞 · 1 在推进 · 2 待办为主 · 3 基本完工(≥80%) · 9 工作未知
 * 这是「工作未知桶降权」的机械实现:它不参与前四档竞争,恒为最后。
 */
export function zoneRank(progress: ZoneProgress): number {
  if (progress.unknownWork) return 9;
  if (progress.blocked > 0) return 0;
  if (progress.doneRatio >= 0.8) return 3;
  if (progress.open > 0 || progress.inReview > 0) return 1;
  return 2;
}

export interface WorkCluster {
  /** 工作的根 taskId;「工作未知」块为 UNKNOWN_WORK 哨兵。 */
  rootId: string;
  title: string;
  tasks: readonly TaskRow[];
  progress: ZoneProgress;
}

/**
 * 一个 task 所属工作的根(task 与 fact 分区共用这一份判定):rootTaskId 优先;缺失时
 * 沿本集合内的父链上溯,到顶即为根(没有父任务的 task 自己就是一个工作的根)。
 * 投影只给 parentTaskId 时,父链完整的上溯是确定性推导,不是猜归属;task 不在集合、
 * 父任务不在集合内(不可见)或父链成环 → undefined(工作未知),不伪装成根。
 */
export function workRootResolver(tasks: ReadonlyArray<TaskRow>): (taskId: string) => string | undefined {
  const byId = new Map(tasks.map((task) => [task.taskId, task] as const));
  return (taskId) => {
    const seen = new Set<string>();
    let current = byId.get(taskId);
    while (current !== undefined && !seen.has(current.taskId)) {
      if (current.rootTaskId) return current.rootTaskId;
      if (!current.parentTaskId) return current.taskId;
      seen.add(current.taskId);
      current = byId.get(current.parentTaskId);
    }
    return undefined;
  };
}

/** 按工作(根 task)聚簇;所属工作无法确定的 task 进「工作未知」块。任何情况都不猜归属。 */
export function clusterTasksByWork(tasks: ReadonlyArray<TaskRow>): WorkCluster[] {
  const titleById = new Map<string, string>();
  for (const task of tasks) titleById.set(task.taskId, task.title);
  const rootOf = workRootResolver(tasks);

  const groups = new Map<string, TaskRow[]>();
  const unknown: TaskRow[] = [];
  for (const task of tasks) {
    const root = rootOf(task.taskId);
    if (!root) {
      unknown.push(task);
      continue;
    }
    const list = groups.get(root) ?? [];
    list.push(task);
    groups.set(root, list);
  }

  const clusters: WorkCluster[] = [];
  for (const [rootId, group] of groups) {
    const sorted = [...group].sort(taskImportance);
    clusters.push({
      rootId,
      title: workTitle(rootId, group, titleById),
      tasks: sorted,
      progress: deriveZoneProgress(sorted),
    });
  }
  if (unknown.length > 0) {
    clusters.push({
      rootId: UNKNOWN_WORK,
      title: UNKNOWN_WORK_TITLE,
      tasks: [...unknown].sort(taskImportance),
      progress: deriveZoneProgress(unknown, true),
    });
  }

  return clusters.sort(
    (a, b) =>
      zoneRank(a.progress) - zoneRank(b.progress) ||
      b.progress.total - a.progress.total ||
      a.title.localeCompare(b.title),
  );
}

function workTitle(rootId: string, group: ReadonlyArray<TaskRow>, titleById: ReadonlyMap<string, string>): string {
  const fromRow = group.find((task) => task.rootTitle)?.rootTitle;
  return fromRow ?? titleById.get(rootId) ?? rootId;
}

/** task 重要性:排序权重由投影的 `board.rank` 给;同档按标题稳定排序。 */
function taskImportance(a: TaskRow, b: TaskRow): number {
  return a.board.rank - b.board.rank || a.title.localeCompare(b.title);
}
