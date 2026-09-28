import type { TaskRow } from "../model/types";

/**
 * 领地的「每个工作的进度」(老版领地视图的核心能力,rebuild 线丢失后在此找回)。
 *
 * 工作(dec_5F7E74F1)= 一个工作根 task 加它的 parentTaskId 子树。task 所属工作由 daemon
 * 工作索引(`repo.works.index`)给出,落在行上的 workId;领地 task 分区按 workId 聚簇成
 * 工作块(与 `ha work list` 一一对应,嵌套的声明工作自成一块),每块带自己的状态构成与完成率。
 *
 * 构成与排序都读 daemon 投影的 `board`(dec_5B135F46 CH4):列由 `board.columnId` 给,
 * 块内顺序由 `board.rank` 给,renderer 不再自己把状态词分桶或排权重。
 * 不属于任何工作的 task(独立任务)显式归入「独立任务」块,只降权重排,不隐藏;
 * renderer 不沿父链自己判定归属。
 */

/** 内部哨兵:不属于任何工作。渲染侧翻成 NO_WORK_TITLE。 */
export const NO_WORK = "__no_work__";
export const NO_WORK_TITLE = "独立任务";

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
  /** 该块是否是「独立任务」块(不属于任何工作)。 */
  noWork: boolean;
}

const EMPTY_PROGRESS: ZoneProgress = {
  total: 0,
  terminal: 0,
  open: 0,
  blocked: 0,
  inReview: 0,
  unplaced: 0,
  doneRatio: 0,
  noWork: false,
};

/** 一组 task 的看板列构成 + 完成率。 */
export function deriveZoneProgress(tasks: ReadonlyArray<TaskRow>, noWork = false): ZoneProgress {
  if (tasks.length === 0) return { ...EMPTY_PROGRESS, noWork };
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
    noWork,
  };
}

/**
 * zone 排序键(小的排前面)。承重排序:**有阻塞的工作最先看见,独立任务永远沉底**。
 *   0 有阻塞 · 1 在推进 · 2 待办为主 · 3 基本完工(≥80%) · 9 独立任务
 * 这是「独立任务桶降权」的机械实现:它不参与前四档竞争,恒为最后。
 */
export function zoneRank(progress: ZoneProgress): number {
  if (progress.noWork) return 9;
  if (progress.blocked > 0) return 0;
  if (progress.doneRatio >= 0.8) return 3;
  if (progress.open > 0 || progress.inReview > 0) return 1;
  return 2;
}

export interface WorkCluster {
  /** 工作的根 taskId;「独立任务」块为 NO_WORK 哨兵。 */
  rootId: string;
  title: string;
  tasks: readonly TaskRow[];
  progress: ZoneProgress;
}

/** 按所属工作(daemon 给的 workId)聚簇;不属于任何工作的 task 进「独立任务」块。 */
export function clusterTasksByWork(tasks: ReadonlyArray<TaskRow>): WorkCluster[] {
  const groups = new Map<string, TaskRow[]>();
  const titles = new Map<string, string>();
  const standalone: TaskRow[] = [];
  for (const task of tasks) {
    if (!task.workId) {
      standalone.push(task);
      continue;
    }
    const list = groups.get(task.workId) ?? [];
    list.push(task);
    groups.set(task.workId, list);
    if (task.workTitle) titles.set(task.workId, task.workTitle);
  }

  const clusters: WorkCluster[] = [];
  for (const [rootId, group] of groups) {
    const sorted = [...group].sort(taskImportance);
    clusters.push({
      rootId,
      title: titles.get(rootId) ?? rootId,
      tasks: sorted,
      progress: deriveZoneProgress(sorted),
    });
  }
  if (standalone.length > 0) {
    clusters.push({
      rootId: NO_WORK,
      title: NO_WORK_TITLE,
      tasks: [...standalone].sort(taskImportance),
      progress: deriveZoneProgress(standalone, true),
    });
  }

  return clusters.sort(
    (a, b) =>
      zoneRank(a.progress) - zoneRank(b.progress) ||
      b.progress.total - a.progress.total ||
      a.title.localeCompare(b.title),
  );
}

/** task 重要性:排序权重由投影的 `board.rank` 给;同档按标题稳定排序。 */
function taskImportance(a: TaskRow, b: TaskRow): number {
  return a.board.rank - b.board.rank || a.title.localeCompare(b.title);
}
