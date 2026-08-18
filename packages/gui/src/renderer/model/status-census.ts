import type { SnapshotStatus, TaskRow } from "./types.ts";

/**
 * 总览统计的唯一口径:每个数字 = coordinationStatus 恰等于该 kernel 状态词的任务数。
 *
 * 数据来源:repo.tasks.list 投影行经 task-adapter 适配后的 coordinationStatus
 * (kernel task/v1 状态词原文,仅叠加 blocked relation overlay:canonical 仍是
 * planned/active 但存在 active blocking relation 时显示 blocked)。总数 = 该仓
 * 投影的全部任务行(含 done / cancelled / archived 行)。
 *
 * 侧栏与总览卡片共用本函数,两侧数字必须逐字相等;前端不再发明第二个聚合词
 * (如把 active+blocked+in_review 合称「活跃」——那个词与 kernel 状态词 active
 * 撞名,48 进行中对 91 活跃就是这么来的)。
 */
export function coordinationStatusCensus(tasks: ReadonlyArray<TaskRow>): ReadonlyMap<SnapshotStatus, number> {
  const census = new Map<SnapshotStatus, number>();
  for (const task of tasks) census.set(task.coordinationStatus, (census.get(task.coordinationStatus) ?? 0) + 1);
  return census;
}
