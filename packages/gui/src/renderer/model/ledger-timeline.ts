import type { TaskRow } from "./types.ts";

/**
 * 总览任务流的排序模型(任务与决策分流后,本模块只管任务侧;决策流见
 * triadic.sortDecisionQueue)。
 *
 * 时间来源:kernel mint 的 taskId 自带创建时间戳段(task_ + base32(ms,10) +
 * 熵,见 kernel layout/generateTaskId)。当前 repo.tasks.list 投影行不携带
 * createdAt,前端从 id 派生——这是 mint 规则的确定性解码,不是猜。
 * 解不出时间的实体(重放/导入的任意 id)排尾部,时间显示「—」,
 * 不拿 lastKnownAt 冒充创建时间。
 */

/** kernel Crockford base32 字母表(与 layout/index.ts 的 crockfordBase32 一致)。 */
const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * 从 taskId 解出创建时间。只认 kernel mint 形态(与 layout/index.ts 的
 * taskIdPattern 一致:task_ + 恰好 26 位 base32,前 10 位是时间戳段);
 * 其余 id(重放/导入的任意 id、decision 的哈希 id)返回 null——宁可未知,
 * 不给假时间。
 */
export function ledgerIdCreatedAt(id: string): string | null {
  if (!/^task_[0-9A-HJKMNP-TV-Z]{26}$/u.test(id)) return null;
  const stamp = id.slice(5, 15);
  let millis = 0;
  for (const char of stamp) millis = millis * 32 + CROCKFORD_BASE32.indexOf(char);
  const date = new Date(millis);
  return Number.isFinite(date.getTime()) && millis > 0 ? date.toISOString() : null;
}

export function taskCreatedAt(task: TaskRow): string | null {
  return ledgerIdCreatedAt(task.taskId);
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
