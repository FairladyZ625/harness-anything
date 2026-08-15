import type { TaskRow, SnapshotStatus } from "../model/types";
import { resolveTaskModule, UNPROJECTED_MODULE } from "./moduleAssignment";

/**
 * 领地的「每个 PRD 任务的进度」(老版领地视图的核心能力,rebuild 线丢失后在此找回)。
 *
 * 内核里 milestone / PRD 就是**根 task**:task 树沿 parentTaskId 上溯,根即 rootTaskId。
 * 所以领地 task 分区不再按 module 摊平(那正是「一片混乱 + 未投影占 C 位」的成因),
 * 而是按 rootTaskId 聚簇成 PRD 块,每块带自己的状态构成与完成率。
 *
 * 全部由现有 triadic projection 前端派生:不新增查询、不改后端契约。
 * 诚实边界:rootTaskId / module 缺失的 task 仍然显式归入「未投影」,只降权重排,不隐藏、
 * 不补默认值冒充已投影(REQ-GUI-03 验收硬项)。
 */

export interface ZoneProgress {
  total: number;
  done: number;
  active: number;
  blocked: number;
  inReview: number;
  planned: number;
  /** cancelled + unknown:不计入完成率分母之外,但单列出来避免「消失」。 */
  other: number;
  /** 完成率 = done / total,0..1。 */
  doneRatio: number;
  /** 该块是否属于未投影(缺 root/module 字段)。 */
  unprojected: boolean;
}

const EMPTY_PROGRESS: ZoneProgress = {
  total: 0, done: 0, active: 0, blocked: 0, inReview: 0, planned: 0, other: 0,
  doneRatio: 0, unprojected: false,
};

/** 一组 task 的状态构成 + 完成率。 */
export function deriveZoneProgress(
  tasks: ReadonlyArray<TaskRow>,
  unprojected = false,
): ZoneProgress {
  if (tasks.length === 0) return { ...EMPTY_PROGRESS, unprojected };
  let done = 0;
  let active = 0;
  let blocked = 0;
  let inReview = 0;
  let planned = 0;
  let other = 0;
  for (const task of tasks) {
    switch (statusBucket(task.coordinationStatus)) {
      case "done": done += 1; break;
      case "active": active += 1; break;
      case "blocked": blocked += 1; break;
      case "in_review": inReview += 1; break;
      case "planned": planned += 1; break;
      default: other += 1;
    }
  }
  return {
    total: tasks.length,
    done, active, blocked, inReview, planned, other,
    doneRatio: done / tasks.length,
    unprojected,
  };
}

function statusBucket(status: SnapshotStatus): SnapshotStatus {
  if (status === "done" || status === "active" || status === "blocked") return status;
  if (status === "in_review") return "in_review";
  if (status === "planned") return "planned";
  return "unknown";
}

/**
 * zone 排序键(小的排前面)。承重排序:**有阻塞的 PRD 最先看见,未投影永远沉底**。
 *   0 有阻塞 · 1 在推进 · 2 待办为主 · 3 基本完工(≥80%) · 9 未投影
 * 这是「未投影桶降权」的机械实现:它不参与前四档竞争,恒为最后。
 */
export function zoneRank(progress: ZoneProgress): number {
  if (progress.unprojected) return 9;
  if (progress.blocked > 0) return 0;
  if (progress.doneRatio >= 0.8) return 3;
  if (progress.active > 0 || progress.inReview > 0) return 1;
  return 2;
}

export interface PrdCluster {
  /** 根 taskId;未投影块为 UNPROJECTED_MODULE 哨兵。 */
  rootId: string;
  title: string;
  tasks: TaskRow[];
  progress: ZoneProgress;
}

/**
 * 按 PRD(根 task)聚簇。
 *
 * rootTaskId 缺失时:该 task 自身若有子任务则自成一块(它就是根);否则按 module 兜底聚合,
 * module 也缺 → 未投影块。任何情况都不猜 PRD 归属。
 */
export function clusterTasksByPrd(tasks: ReadonlyArray<TaskRow>): PrdCluster[] {
  const titleById = new Map<string, string>();
  for (const task of tasks) titleById.set(task.taskId, task.title);

  // 投影只给 parentTaskId,不给 rootTaskId。父链完整时上溯到根是确定性推导,不是猜归属。
  // 父不在本集合内(不可见)或成环时归属仍然未知 —— 返回 undefined 交给 module 兜底,不伪装成根。
  const parentById = new Map<string, string>();
  for (const task of tasks) if (task.parentTaskId) parentById.set(task.taskId, task.parentTaskId);
  const rootOf = (taskId: string): string | undefined => {
    const seen = new Set<string>();
    for (let current = taskId; ; ) {
      if (seen.has(current)) return undefined;
      seen.add(current);
      const parent = parentById.get(current);
      if (!parent) return current;
      if (!titleById.has(parent)) return undefined;
      current = parent;
    }
  };

  const groups = new Map<string, TaskRow[]>();
  const unprojected: TaskRow[] = [];
  for (const task of tasks) {
    const root = task.rootTaskId ?? rootOf(task.taskId);
    if (root) {
      const list = groups.get(root) ?? [];
      list.push(task);
      groups.set(root, list);
      continue;
    }
    // 无 root 又有 parent:PRD 归属未投影,按 module 兜底,module 也缺则进未投影块。
    const module = resolveTaskModule(task.module);
    if (module === UNPROJECTED_MODULE) {
      unprojected.push(task);
      continue;
    }
    const list = groups.get(`module:${module}`) ?? [];
    list.push(task);
    groups.set(`module:${module}`, list);
  }

  const clusters: PrdCluster[] = [];
  for (const [rootId, group] of groups) {
    const sorted = [...group].sort(taskImportance);
    clusters.push({
      rootId,
      title: prdTitle(rootId, group, titleById),
      tasks: sorted,
      progress: deriveZoneProgress(sorted),
    });
  }
  if (unprojected.length > 0) {
    clusters.push({
      rootId: UNPROJECTED_MODULE,
      title: "未投影",
      tasks: [...unprojected].sort(taskImportance),
      progress: deriveZoneProgress(unprojected, true),
    });
  }

  return clusters.sort(
    (a, b) =>
      zoneRank(a.progress) - zoneRank(b.progress) ||
      b.progress.total - a.progress.total ||
      a.title.localeCompare(b.title),
  );
}

function prdTitle(
  rootId: string,
  group: ReadonlyArray<TaskRow>,
  titleById: ReadonlyMap<string, string>,
): string {
  if (rootId.startsWith("module:")) return rootId.slice(7);
  const fromRow = group.find((task) => task.rootTitle)?.rootTitle;
  return fromRow ?? titleById.get(rootId) ?? rootId;
}

/** task 重要性:阻塞 > 进行 > 评审 > 规划 > 完成/其他;同档按标题稳定排序。 */
function taskImportance(a: TaskRow, b: TaskRow): number {
  return statusWeight(a.coordinationStatus) - statusWeight(b.coordinationStatus)
    || a.title.localeCompare(b.title);
}

function statusWeight(status: SnapshotStatus): number {
  switch (status) {
    case "blocked": return 0;
    case "active": return 1;
    case "in_review": return 2;
    case "planned": return 3;
    case "done": return 4;
    default: return 5;
  }
}
