import {
  scopedPersonId,
  taskMatchesCollaboratorScope,
  type CollaboratorScope,
} from "@harness-anything/kernel/internal/domain/collaborator-scope.ts";
import type * as ProjectionStatus from "@harness-anything/kernel/internal/domain/task-read-set.ts";
import { taskPresentationReads } from "./task-presentation-read.ts";
import { type TaskProjection, type TaskIndexProjectionRow, type TaskV2 } from "@harness-anything/kernel";
import type { CanonicalEventSummary } from "@harness-anything/kernel";
import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";

const WORKSPACE_EVENT_LIMIT = storageReadPolicy.defaultValue.listDefaults.workspaceEventLimit;

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
  readonly status: ProjectionStatus.ReadSetProjectionCut["status"];
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
  /** Most recent event list rows for the root and descendants; canonical payloads stay server-side. */
  readonly eventSummaries: readonly CanonicalEventSummary[];
  readonly eventWindowComplete: boolean;
  readonly tasks: readonly WorkspaceScopeTaskRow[];
  readonly page: { readonly limit: number; readonly cursor: string | null; readonly nextCursor: string | null };
  readonly incompleteParentRefs: readonly string[];
  readonly watermark: number;
  readonly sourceRevision: number;
  readonly warnings: readonly string[];
}

export type WorkspaceStructureRead = Omit<WorkspaceScopeRead, "eventSummaries" | "eventWindowComplete">;

/** The GUI scope read: the work's structure plus its newest event summaries on the first page. */
export function workspaceScopeFromProjection(
  projection: TaskProjection,
  input: CollaboratorScope & { readonly rootTaskId: string; readonly limit?: number; readonly cursor?: string },
): WorkspaceScopeRead {
  const structure = workspaceStructureFromProjection(projection, input),
    eventWindow = input.cursor
      ? { summaries: [] as readonly CanonicalEventSummary[], complete: false }
      : workspaceEventSummaries(projection, [structure.root.taskId, ...structure.memberTaskIds], input);
  return { ...structure, eventSummaries: eventWindow.summaries, eventWindowComplete: eventWindow.complete };
}

/** Structure only; agenda and work show call this and never scan events. */
export function workspaceStructureFromProjection(
  projection: TaskProjection,
  input: CollaboratorScope & { readonly rootTaskId: string; readonly limit?: number; readonly cursor?: string },
): WorkspaceStructureRead {
  const personId = scopedPersonId(input),
    scoped = personId !== undefined || input.filterNodeId !== undefined,
    read = scoped
      ? projection.readTaskIndex({ scopeRootTaskId: input.rootTaskId, withAttribution: true })
      : taskPresentationReads(projection).readTaskIndex({ scopeRootTaskId: input.rootTaskId });
  const byId = new Map(read.rows.map((row) => [row.taskId, row]));
  const root = byId.get(input.rootTaskId);
  if (!root) throw new Error(`Workspace root task not found: ${input.rootTaskId}`);

  const children = new Map<string, TaskIndexProjectionRow[]>();
  for (const row of read.rows) {
    if (row.parentTaskId === null) continue;
    const siblings = children.get(row.parentTaskId);
    if (siblings) siblings.push(row);
    else children.set(row.parentTaskId, [row]);
  }
  const descendants: TaskIndexProjectionRow[] = [];
  const pending = [...(children.get(root.taskId) ?? [])];
  const seen = new Set([root.taskId]);
  for (let index = 0; index < pending.length; index += 1) {
    const row = pending[index]!;
    if (seen.has(row.taskId)) continue;
    seen.add(row.taskId);
    descendants.push(row);
    for (const child of children.get(row.taskId) ?? []) pending.push(child);
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
    ancestors.push(parent);
    parentId = parent.parentTaskId;
  }

  const members = scoped ? descendants.filter((row) => taskMatchesCollaboratorScope(input, row)) : descendants,
    visibleGroupIds = new Set(members.map(({ taskId }) => taskId));
  for (const row of descendants.toReversed())
    if (row.parentTaskId !== null && visibleGroupIds.has(row.taskId)) visibleGroupIds.add(row.parentTaskId);
  const groups = descendants.filter((row) => children.has(row.taskId) && visibleGroupIds.has(row.taskId)),
    leaves = members.filter((row) => !children.has(row.taskId)),
    personalPins =
      personId === undefined
        ? null
        : new Set(projection.listPinnedEntities(personId).map(({ entityRef }) => entityRef));
  const counts: Record<keyof WorkspaceScopeStatusCounts, number> = emptyScopeCounts();
  for (const row of leaves) counts[scopeStatus(row.status)] += 1;
  const sortedLeaves = [...leaves].sort((left, right) => left.taskId.localeCompare(right.taskId));
  const limit = input.limit ?? 100;
  const start = input.cursor ? sortedLeaves.findIndex(({ taskId }) => taskId.localeCompare(input.cursor!) > 0) : 0;
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
    pinned: personalPins === null ? task.pinned : personalPins.has(`task/${task.taskId}`),
    hasChildren: children.has(task.taskId),
  });
  return {
    schema: "daemon.workspace-scope/v1",
    ok: true,
    status: read.status,
    root: row(root),
    ancestors: ancestors.reverse().map(row),
    goalMaterial: root.packagePath ? { taskId: root.taskId, path: "task_plan.md" } : null,
    counts,
    scope: {
      descendantCount: members.length,
      executableLeafCount: leaves.length,
      archivedCount: members.filter(({ packageDisposition }) => packageDisposition !== "active").length,
    },
    groups: groups.map(row),
    memberTaskIds: members.map(({ taskId }) => taskId).sort(),
    tasks: pageRows.map(row),
    page: { limit, cursor: input.cursor ?? null, nextCursor },
    incompleteParentRefs,
    watermark: read.watermark,
    sourceRevision: read.sourceRevision,
    warnings: read.warnings,
  };
}

function workspaceEventSummaries(
  projection: TaskProjection,
  taskIds: readonly string[],
  scope: CollaboratorScope,
): { readonly summaries: readonly CanonicalEventSummary[]; readonly complete: boolean } {
  const actorPersonId = scopedPersonId(scope),
    page = projection.readEventSummaries(0, WORKSPACE_EVENT_LIMIT, {
      taskIds,
      ...(actorPersonId === undefined ? {} : { actorPersonId }),
      ...(scope.filterNodeId === undefined ? {} : { nodeId: scope.filterNodeId }),
    });
  return { summaries: page.events, complete: page.hasMore === false };
}

export function emptyScopeCounts(): Record<keyof WorkspaceScopeStatusCounts, number> {
  return { done: 0, executing: 0, pending: 0, blocked: 0, planned: 0, cancelled: 0 };
}

export function scopeStatus(status: TaskIndexProjectionRow["status"]): keyof WorkspaceScopeStatusCounts {
  if (status === "active") return "executing";
  if (status === "submitted" || status === "in_review") return "pending";
  return status;
}

/** The fields the work rule reads from a task, whichever read supplies it. */
export interface WorkRuleTask {
  readonly taskId: string;
  readonly title: string;
  readonly taskClass: TaskIndexProjectionRow["taskClass"];
  readonly parentTaskId: string | null;
}

/**
 * The work a task filed under `taskId` belongs to: the nearest declared work (taskClass=work) walking up
 * from `taskId` itself, else the topmost ancestor — the dispatch causal context's rule.
 */
export function workRootOf(
  projection: Pick<TaskProjection, "read">,
  taskId: string,
): { readonly taskId: string; readonly title: string } | null {
  const work = workRootWalk(taskId, (id) => {
    const task: TaskV2 | null | undefined = projection.read(id).snapshot.task;
    return task
      ? {
          taskId: task.taskId,
          title: task.title,
          taskClass: task.taskClass,
          parentTaskId: task.metadata?.parentTaskId ?? null,
        }
      : undefined;
  });
  return work === null ? null : { taskId: work.taskId, title: work.title };
}

/** `workRootOf`'s walk over any task lookup; the one implementation of the rule. */
export function workRootWalk<Task extends WorkRuleTask>(
  taskId: string,
  lookup: (taskId: string) => Task | undefined,
): Task | null {
  let work: Task | null = null;
  const seen = new Set<string>();
  for (let id: string | null = taskId; id !== null && !seen.has(id); ) {
    seen.add(id);
    const task = lookup(id);
    if (!task) break;
    work = task;
    id = task.taskClass === "work" ? null : task.parentTaskId;
  }
  return work;
}
