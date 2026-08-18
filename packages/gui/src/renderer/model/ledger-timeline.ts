import type { DecisionRow, TaskRow } from "./types.ts";

/**
 * 主页任务流(老 Archive 主线的时间线形态,用现有投影重实现)。
 *
 * 时间来源:
 * - task:kernel mint 的 taskId 自带创建时间戳段(task_ + base32(ms,10) + 熵,
 *   见 kernel layout/generateTaskId)。当前 repo.tasks.list 投影行不再携带
 *   createdAt,前端从 id 派生——这是 mint 规则的确定性解码,不是猜。
 * - decision:投影行必带 proposedAt(daemon 契约 nonEmpty),直接用;
 *   decisionId 是 opId 哈希,不含时间信息,不做 id 解码。
 * - 解不出时间的实体(重放/导入的任意 id)排尾部,时间显示「—」,
 *   不拿 lastKnownAt 冒充创建时间。
 */
export interface LedgerTimelineEntry {
  readonly kind: "task" | "decision";
  readonly id: string;
  readonly title: string;
  /** 创建/提案时间;null = 无法从投影确定。 */
  readonly at: string | null;
}

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

export function decisionCreatedAt(decision: DecisionRow): string | null {
  return decision.proposedAt ?? null;
}

/** 任务 + 决策按创建时间倒序混排;最新在最上面,无时间的排尾部。 */
export function buildLedgerTimeline(
  tasks: ReadonlyArray<TaskRow>,
  decisions: ReadonlyArray<DecisionRow>,
): readonly LedgerTimelineEntry[] {
  const entries: LedgerTimelineEntry[] = [
    ...tasks.map((task) => ({ kind: "task" as const, id: task.taskId, title: task.title, at: taskCreatedAt(task) })),
    ...decisions.map((decision) => ({ kind: "decision" as const, id: decision.decisionId, title: decision.title, at: decisionCreatedAt(decision) })),
  ];
  return entries.sort((left, right) => {
    if (left.at === null && right.at === null) return right.id.localeCompare(left.id);
    if (left.at === null) return 1;
    if (right.at === null) return -1;
    return right.at.localeCompare(left.at) || right.id.localeCompare(left.id);
  });
}
