import type { DecisionRow, TaskRow } from "./types.ts";

const TERMINAL = new Set(["done", "cancelled"]);

export type LedgerEvent =
  | { kind: "decision_created"; at: string; id: string; title: string }
  | { kind: "task_created" | "task_terminal"; at: string; id: string; title: string };

export interface PltGroup {
  rootId: string;
  title: string;
  tasks: TaskRow[];
  openCount: number;
  staleCount: number;
  terminalCount: number;
}

export interface LedgerOverviewModel {
  events: LedgerEvent[];
  plt: PltGroup[];
  ungrouped: PltGroup;
}

export function buildLedgerOverview(
  tasks: readonly TaskRow[],
  decisions: readonly DecisionRow[],
  eventLimit = 12,
): LedgerOverviewModel {
  const groups = new Map<string, TaskRow[]>();
  for (const task of tasks) {
    const root = task.rootTaskId ?? task.taskId;
    const bucket = groups.get(root) ?? [];
    bucket.push(task);
    groups.set(root, bucket);
  }

  const plt: PltGroup[] = [];
  const singletonTasks: TaskRow[] = [];
  for (const [rootId, members] of groups) {
    if (members.length === 1) singletonTasks.push(members[0]!);
    else plt.push(toPltGroup(rootId, members));
  }
  plt.sort((left, right) => {
    const activity = Number(right.openCount > 0) - Number(left.openCount > 0);
    return activity || right.openCount - left.openCount || right.tasks.length - left.tasks.length || left.title.localeCompare(right.title);
  });

  const events: LedgerEvent[] = [];
  for (const task of tasks) {
    const createdAt = task.createdAt ?? ledgerIdCreatedAt(task.taskId);
    if (createdAt) events.push({ kind: "task_created", at: createdAt, id: task.taskId, title: task.title });
    if (TERMINAL.has(task.coordinationStatus) && task.terminalAt) {
      events.push({ kind: "task_terminal", at: task.terminalAt, id: task.taskId, title: task.title });
    }
  }
  for (const decision of decisions) {
    const at = decision.proposedAt ?? ledgerIdCreatedAt(decision.decisionId);
    if (at) events.push({ kind: "decision_created", at, id: decision.decisionId, title: decision.title });
  }
  events.sort((left, right) => right.at.localeCompare(left.at) || right.id.localeCompare(left.id));

  return {
    events: events.slice(0, eventLimit),
    plt,
    ungrouped: toPltGroup("unassigned", singletonTasks, "No PLT"),
  };
}

function toPltGroup(rootId: string, tasks: TaskRow[], title?: string): PltGroup {
  const terminalCount = tasks.filter((task) => TERMINAL.has(task.coordinationStatus)).length;
  const open = tasks.filter((task) => !TERMINAL.has(task.coordinationStatus));
  return {
    rootId,
    title: title ?? tasks.find((task) => task.taskId === rootId)?.title ?? tasks[0]?.rootTitle ?? rootId,
    tasks: [...tasks].sort((left, right) => {
      const rightAt = right.createdAt ?? ledgerIdCreatedAt(right.taskId) ?? "";
      const leftAt = left.createdAt ?? ledgerIdCreatedAt(left.taskId) ?? "";
      return rightAt.localeCompare(leftAt);
    }),
    openCount: open.length,
    staleCount: open.filter((task) => task.liveness === "stale").length,
    terminalCount,
  };
}

export function ledgerIdCreatedAt(id: string): string | null {
  const value = id.includes("_") ? id.slice(id.indexOf("_") + 1, id.indexOf("_") + 11) : id.slice(0, 10);
  if (!/^[0-9A-HJKMNP-TV-Z]{10}$/u.test(value)) return null;
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let millis = 0;
  for (const char of value) millis = millis * 32 + alphabet.indexOf(char);
  const date = new Date(millis);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
