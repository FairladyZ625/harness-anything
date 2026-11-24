import {
  collaboratorTaskActivityAt,
  scopedPersonId,
  taskMatchesCollaboratorActivity,
  taskMatchesCollaboratorScope,
  type CollaboratorScope,
} from "@harness-anything/kernel/internal/domain/collaborator-scope.ts";
import type * as ProjectionStatus from "@harness-anything/kernel/internal/domain/task-read-set.ts";
import {
  isTerminalStatus,
  isWorkRoot,
  type TaskProjection,
  type TaskProjectionQueries,
  type TaskIndexProjectionRow,
  type TaskV2,
} from "@harness-anything/kernel";
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
  projection: TaskProjectionQueries,
  input: CollaboratorScope & { readonly rootTaskId: string; readonly limit?: number; readonly cursor?: string },
): WorkspaceStructureRead {
  const personId = scopedPersonId(input),
    scoped = personId !== undefined || input.filterNodeId !== undefined,
    read = projection.readTaskIndex({
      scopeRootTaskId: input.rootTaskId,
      ...(scoped ? { withAttribution: true } : {}),
    });
  const byId = new Map(read.rows.map((row) => [row.taskId, row]));
  const root = byId.get(input.rootTaskId);
  if (!root) throw new Error(`Workspace root task not found: ${input.rootTaskId}`);

  const children = taskChildren(read.rows);
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
  const groups = descendants.filter((row) => !isExecutableLeaf(row, children) && visibleGroupIds.has(row.taskId)),
    leaves = members.filter((row) => isExecutableLeaf(row, children)),
    personalPins =
      personId === undefined
        ? null
        : new Set(projection.listPinnedEntities(personId).map(({ entityRef }) => entityRef));
  const summaries = workSubtreeSummaries([root, ...descendants], children, input),
    counts = summaries.get(root.taskId)!.counts;
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
    status:
      summaries.has(task.taskId) &&
      isWorkRoot(task.taskClass, task.parentTaskId, children.get(task.taskId)?.length ?? 0)
        ? workPresentationStatus(task.status, summaries.get(task.taskId)!.counts, scoped)
        : task.status,
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

function emptyScopeCounts(): Record<keyof WorkspaceScopeStatusCounts, number> {
  return { done: 0, executing: 0, pending: 0, blocked: 0, planned: 0, cancelled: 0 };
}

export function taskChildren(rows: readonly TaskIndexProjectionRow[]): Map<string, TaskIndexProjectionRow[]> {
  const children = new Map<string, TaskIndexProjectionRow[]>();
  for (const row of rows) {
    if (row.parentTaskId === null) continue;
    const siblings = children.get(row.parentTaskId);
    if (siblings) siblings.push(row);
    else children.set(row.parentTaskId, [row]);
  }
  return children;
}

function isExecutableLeaf(
  row: TaskIndexProjectionRow,
  children: ReadonlyMap<string, readonly TaskIndexProjectionRow[]>,
): boolean {
  return row.taskClass !== "work" && !children.has(row.taskId);
}

interface WorkSubtreeSummary {
  counts: Record<keyof WorkspaceScopeStatusCounts, number>;
  taskCount: number;
  lastActivityAt: string | null;
  remainingChildren: number;
}

/** Roll up each edge once, including edges across archived packages and nested Work roots. */
export function workSubtreeSummaries(
  rows: readonly TaskIndexProjectionRow[],
  children: ReadonlyMap<string, readonly TaskIndexProjectionRow[]>,
  scope: CollaboratorScope,
): ReadonlyMap<string, WorkSubtreeSummary> {
  const summaries = new Map<string, WorkSubtreeSummary>(),
    ready: TaskIndexProjectionRow[] = [],
    byId = new Map(rows.map((row) => [row.taskId, row])),
    buckets = Object.keys(emptyScopeCounts()) as (keyof WorkspaceScopeStatusCounts)[];
  for (const row of rows) {
    const remainingChildren = children.get(row.taskId)?.length ?? 0;
    summaries.set(row.taskId, { remainingChildren, taskCount: 0, counts: emptyScopeCounts(), lastActivityAt: null });
    if (remainingChildren === 0) ready.push(row);
  }
  for (let index = 0; index < ready.length; index += 1) {
    const row = ready[index]!,
      parent = row.parentTaskId === null ? undefined : byId.get(row.parentTaskId);
    if (!parent) continue;
    const current = summaries.get(row.taskId)!,
      total = summaries.get(parent.taskId)!;
    total.taskCount += current.taskCount;
    for (const bucket of buckets) total.counts[bucket] += current.counts[bucket];
    const activity = collaboratorTaskActivityAt(scope, row);
    if (taskMatchesCollaboratorScope(scope, row)) {
      total.taskCount += 1;
      if (isExecutableLeaf(row, children) && taskMatchesCollaboratorActivity(scope, row))
        total.counts[scopeStatus(row.status)] += 1;
    }
    for (const at of [current.lastActivityAt, activity])
      if (at !== null && (total.lastActivityAt === null || at > total.lastActivityAt)) total.lastActivityAt = at;
    total.remainingChildren -= 1;
    if (total.remainingChildren === 0) ready.push(parent);
  }
  return summaries;
}

function scopeStatus(status: TaskIndexProjectionRow["status"]): keyof WorkspaceScopeStatusCounts {
  if (status === "active") return "executing";
  if (status === "submitted" || status === "in_review") return "pending";
  return status;
}

export function workPresentationStatus(
  rootStatus: TaskIndexProjectionRow["status"],
  counts: WorkspaceScopeStatusCounts,
  scoped: boolean,
): TaskIndexProjectionRow["status"] {
  if (scoped) {
    if (counts.executing || counts.pending) return "active";
    if (counts.blocked) return "blocked";
    if (counts.planned) return "planned";
  } else {
    if (isTerminalStatus(rootStatus)) return rootStatus;
    if (counts.executing || counts.pending || counts.blocked || counts.planned)
      return rootStatus === "planned" && (counts.executing || counts.pending || counts.blocked || counts.done)
        ? "active"
        : rootStatus;
  }
  return counts.done ? "done" : counts.cancelled ? "cancelled" : rootStatus;
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
