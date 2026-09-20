import type { TaskProjection, TaskIndexProjectionRow } from "../../kernel/src/index.ts";

export interface WorkspaceScopeStatusCounts {
  readonly done: number;
  readonly executing: number;
  readonly pending: number;
  readonly blocked: number;
  readonly planned: number;
  readonly cancelled: number;
}

export interface WorkspaceScopeTaskRow {
  readonly taskId: string;
  readonly title: string;
  readonly status: TaskIndexProjectionRow["status"];
  readonly taskClass: TaskIndexProjectionRow["taskClass"];
  readonly parentTaskId: string | null;
  readonly updatedAt: string;
  readonly pinned: boolean;
  readonly hasChildren: boolean;
}

export interface WorkspaceScopeRead {
  readonly schema: "daemon.workspace-scope/v1";
  readonly ok: true;
  readonly status: "ready" | "pending";
  readonly root: WorkspaceScopeTaskRow;
  readonly ancestors: readonly WorkspaceScopeTaskRow[];
  readonly goalMaterial: { readonly taskId: string; readonly path: string } | null;
  readonly counts: WorkspaceScopeStatusCounts;
  readonly scope: {
    readonly descendantCount: number;
    readonly executableLeafCount: number;
    readonly archivedCount: number;
  };
  readonly groups: readonly WorkspaceScopeTaskRow[];
  /** Canonical membership for consumers that join an existing task projection. */
  readonly memberTaskIds: readonly string[];
  readonly tasks: readonly WorkspaceScopeTaskRow[];
  readonly page: { readonly limit: number; readonly cursor: string | null; readonly nextCursor: string | null };
  readonly incompleteParentRefs: readonly string[];
  readonly watermark: number;
  readonly sourceRevision: number;
  readonly warnings: readonly string[];
}

export function workspaceScopeFromProjection(
  projection: TaskProjection,
  input: { readonly rootTaskId: string; readonly limit?: number; readonly cursor?: string },
): WorkspaceScopeRead {
  const read = projection.readTaskIndex({});
  const byId = new Map(read.rows.map((row) => [row.taskId, row]));
  const root = byId.get(input.rootTaskId);
  if (!root) throw new Error(`Workspace root task not found: ${input.rootTaskId}`);

  const children = new Map<string, TaskIndexProjectionRow[]>();
  for (const row of read.rows) {
    if (row.parentTaskId === null) continue;
    children.set(row.parentTaskId, [...(children.get(row.parentTaskId) ?? []), row]);
  }
  const descendants: TaskIndexProjectionRow[] = [];
  const pending = [...(children.get(root.taskId) ?? [])];
  const seen = new Set([root.taskId]);
  while (pending.length) {
    const row = pending.shift()!;
    if (seen.has(row.taskId)) continue;
    seen.add(row.taskId);
    descendants.push(row);
    pending.push(...(children.get(row.taskId) ?? []));
  }

  const ancestors: TaskIndexProjectionRow[] = [];
  const incompleteParentRefs: string[] = [];
  const ancestorSeen = new Set([root.taskId]);
  let parentId = root.parentTaskId;
  while (parentId !== null) {
    if (ancestorSeen.has(parentId)) {
      incompleteParentRefs.push(parentId);
      break;
    }
    ancestorSeen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) {
      incompleteParentRefs.push(parentId);
      break;
    }
    ancestors.unshift(parent);
    parentId = parent.parentTaskId;
  }

  const groups = descendants.filter((row) => (children.get(row.taskId)?.length ?? 0) > 0);
  const leaves = descendants.filter((row) => !children.has(row.taskId));
  const counts: Record<keyof WorkspaceScopeStatusCounts, number> = emptyCounts();
  for (const row of leaves) counts[scopeStatus(row.status)] += 1;
  const sortedLeaves = [...leaves].sort((left, right) => left.taskId.localeCompare(right.taskId));
  const limit = input.limit ?? 100;
  const start = input.cursor ? sortedLeaves.findIndex(({ taskId }) => taskId > input.cursor!) : 0;
  const pageStart = start < 0 ? sortedLeaves.length : start;
  const pageRows = sortedLeaves.slice(pageStart, pageStart + limit);
  const last = pageRows.at(-1);
  const nextCursor = pageStart + pageRows.length < sortedLeaves.length && last ? last.taskId : null;
  const row = (task: TaskIndexProjectionRow): WorkspaceScopeTaskRow => ({
    taskId: task.taskId,
    title: task.title,
    status: task.status,
    taskClass: task.taskClass,
    parentTaskId: task.parentTaskId,
    updatedAt: task.updatedAt,
    pinned: task.pinned,
    hasChildren: children.has(task.taskId),
  });
  return {
    schema: "daemon.workspace-scope/v1",
    ok: true,
    status: read.status,
    root: row(root),
    ancestors: ancestors.map(row),
    goalMaterial: root.packagePath ? { taskId: root.taskId, path: "task_plan.md" } : null,
    counts,
    scope: {
      descendantCount: descendants.length,
      executableLeafCount: leaves.length,
      archivedCount: descendants.filter(({ packageDisposition }) => packageDisposition !== "active").length,
    },
    groups: groups.map(row),
    memberTaskIds: descendants.map(({ taskId }) => taskId).sort(),
    tasks: pageRows.map(row),
    page: { limit, cursor: input.cursor ?? null, nextCursor },
    incompleteParentRefs,
    watermark: read.watermark,
    sourceRevision: read.sourceRevision,
    warnings: read.warnings,
  };
}

function emptyCounts(): WorkspaceScopeStatusCounts {
  return { done: 0, executing: 0, pending: 0, blocked: 0, planned: 0, cancelled: 0 };
}

function scopeStatus(status: TaskIndexProjectionRow["status"]): keyof WorkspaceScopeStatusCounts {
  if (status === "active") return "executing";
  if (status === "submitted" || status === "in_review") return "pending";
  return status;
}
