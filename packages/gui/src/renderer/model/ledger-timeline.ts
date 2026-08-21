import type { TaskRow } from "./types.ts";

/**
 * 总览任务流的排序模型(任务与决策分流后,本模块只管任务侧;决策流见
 * triadic.sortDecisionQueue)。
 *
 * 创建时间来自 repo.tasks.list 投影的 task_bootstrapped occurredAt。任务 ID
 * 没有时间语义,不得从 ID 推导;没有可靠 bootstrap 事件的导入任务保持未知,
 * 排在尾部。不拿 lastKnownAt 冒充创建时间。
 */
export function taskCreatedAt(task: TaskRow): string | null {
  return task.createdAt ?? null;
}

/** 任务按创建时间倒序;最新在最上面,无时间的排尾部(尾部内按 id 稳定)。 */
export function sortTasksByCreatedDesc(tasks: ReadonlyArray<TaskRow>): TaskRow[] {
  return [...tasks].sort((left, right) => {
    const leftAt = taskCreatedAt(left), rightAt = taskCreatedAt(right);
    if (leftAt === null && rightAt === null) return right.taskId.localeCompare(left.taskId);
    if (leftAt === null) return 1;
    if (rightAt === null) return -1;
    return rightAt.localeCompare(leftAt) || right.taskId.localeCompare(left.taskId);
  });
}
