import {
  isTerminalStatus,
  isWorkRoot,
  type TaskProjection,
  type TaskIndexProjectionRow,
  type TaskV2,
} from "@harness-anything/kernel";
import { canonicalEventSummary, type CanonicalEventSummary } from "./event-summary-read.ts";

const WORKSPACE_EVENT_LIMIT = 120,
  WORKSPACE_EVENT_SCAN_PAGE = 64,
  WORKSPACE_EVENT_SCAN_LIMIT = 2_048;

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
  input: { readonly rootTaskId: string; readonly limit?: number; readonly cursor?: string },
): WorkspaceScopeRead {
  const structure = workspaceStructureFromProjection(projection, input),
    eventWindow = input.cursor
      ? { summaries: [] as readonly CanonicalEventSummary[], complete: false }
      : workspaceEventSummaries(projection, new Set([structure.root.taskId, ...structure.memberTaskIds]));
  return { ...structure, eventSummaries: eventWindow.summaries, eventWindowComplete: eventWindow.complete };
}

/** Structure only; agenda and work show call this and never scan events. */
export function workspaceStructureFromProjection(
  projection: TaskProjection,
  input: { readonly rootTaskId: string; readonly limit?: number; readonly cursor?: string },
): WorkspaceStructureRead {
  const read = projection.readTaskIndex({});
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
    pinned: task.pinned,
    hasChildren: children.has(task.taskId),
  });
  // The root is presented through the work rule when it is one (the same predicate workRows uses),
  // so `ha work show` and the GUI scope read agree with `ha work list` on a derived-terminal root.
  const rootIsWork = isWorkRoot(root.taskClass, root.parentTaskId, children.get(root.taskId)?.length ?? 0);
  return {
    schema: "daemon.workspace-scope/v1",
    ok: true,
    status: read.status,
    root: row({ ...root, status: derivedWorkRootStatus(root, descendants, rootIsWork) }),
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

function workspaceEventSummaries(
  projection: TaskProjection,
  memberTaskIds: ReadonlySet<string>,
): { readonly summaries: readonly CanonicalEventSummary[]; readonly complete: boolean } {
  const probe = projection.readCanonicalEvents(0, 1);
  let before = probe.watermark + 1,
    scanned = 0;
  const selected: CanonicalEventSummary[] = [];
  while (before > 1 && scanned < WORKSPACE_EVENT_SCAN_LIMIT && selected.length < WORKSPACE_EVENT_LIMIT) {
    const after = Math.max(0, before - WORKSPACE_EVENT_SCAN_PAGE - 1),
      page = projection.readCanonicalEvents(after, WORKSPACE_EVENT_SCAN_PAGE + 1),
      eligible = page.events.filter(({ workspaceRevision }) => workspaceRevision < before);
    if (eligible.length === 0) break;
    scanned += eligible.length;
    before = eligible[0]!.workspaceRevision;
    for (let index = eligible.length - 1; index >= 0 && selected.length < WORKSPACE_EVENT_LIMIT; index -= 1) {
      const summary = canonicalEventSummary(eligible[index]!);
      if (typeof summary.taskId === "string" && memberTaskIds.has(summary.taskId)) selected.push(summary);
    }
  }
  return { summaries: selected.reverse(), complete: before <= 1 };
}

export function emptyScopeCounts(): Record<keyof WorkspaceScopeStatusCounts, number> {
  return { done: 0, executing: 0, pending: 0, blocked: 0, planned: 0, cancelled: 0 };
}

/**
 * dec_mr7v4h6t: a work root's status is a read-side projection of its subtree, never a write. When
 * every member is terminal, at least one done derives done and all cancelled derives cancelled; an
 * open member, an empty subtree, or an already-terminal root keeps the root's own status. The
 * canonical status stays untouched — no execution chain runs on the root.
 */
export function derivedWorkRootStatus(
  root: TaskIndexProjectionRow,
  members: readonly TaskIndexProjectionRow[],
  isWorkRoot: boolean,
): TaskIndexProjectionRow["status"] {
  if (
    !isWorkRoot ||
    isTerminalStatus(root.status) ||
    members.length === 0 ||
    !members.every(({ status }) => isTerminalStatus(status))
  )
    return root.status;
  return members.some(({ status }) => status === "done") ? "done" : "cancelled";
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
