import type {
  TaskIndexProjectionRow,
  TaskProjection,
  WriteReceiptDraft as WriteReceipt,
} from "@harness-anything/kernel";
import { isTerminalStatus, isWorkRoot } from "@harness-anything/kernel";
import { planGoalSummary } from "./dispatch-causal-context.ts";
import type { TaskQueryCell } from "./repo-cell-task-query.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import {
  derivedWorkRootStatus,
  emptyScopeCounts,
  scopeStatus,
  workRootWalk,
  workspaceStructureFromProjection,
  type WorkspaceScopeStatusCounts,
  type WorkspaceScopeTaskRow,
} from "./workspace-scope-read.ts";

/**
 * `ha work list|show` (dec_5F7E74F1): a work is one root task plus its parent-child subtree. A root is
 * declared (taskClass=work) or derived (a top-level task that has children). Both reads derive from
 * the task index at one cut and keep no state of their own.
 */
export interface WorkListRow {
  readonly taskId: string;
  readonly title: string;
  /** The presented status: derived from the subtree when every member is terminal, else the root's own. */
  readonly status: TaskIndexProjectionRow["status"];
  readonly root: "declared" | "derived";
  readonly parentTaskId: string | null;
  readonly taskCount: number;
  readonly counts: WorkspaceScopeStatusCounts;
  readonly lastActivityAt: string;
}

export function workListFromProjection(
  projection: TaskProjection,
  input: { readonly all?: boolean; readonly limit?: number },
) {
  const read = projection.readTaskIndex({ activePackagesOnly: true }),
    rows = workRows(read.rows).filter((row) => input.all === true || !isTerminalStatus(row.status));
  return {
    schema: "work-list/v1" as const,
    rows: rows.slice(0, input.limit ?? 50),
    count: rows.length,
    status: read.status,
    watermark: read.watermark,
    sourceRevision: read.sourceRevision,
  };
}

export interface WorkIndexRow extends WorkListRow {
  /** Tasks this work owns by `workRootOf`, the root excluded; a nested declared work owns its own subtree. */
  readonly memberTaskIds: readonly string[];
}

/**
 * Every work at one cut with the tasks that belong to it, for a reader that holds the whole task list but must
 * not re-derive the rule (the GUI): `ha work list --all`'s roots, each task assigned by `workRootOf`'s walk.
 */
export function workIndexFromProjection(projection: TaskProjection) {
  const read = projection.readTaskIndex({ activePackagesOnly: true }),
    byId = new Map(read.rows.map((row) => [row.taskId, row])),
    works = workRows(read.rows),
    members = new Map(works.map(({ taskId }) => [taskId, [] as string[]]));
  for (const row of read.rows) {
    const work = workRootWalk(row.taskId, (id) => byId.get(id));
    if (work !== null && work.taskId !== row.taskId) members.get(work.taskId)?.push(row.taskId);
  }
  return {
    schema: "daemon.work-index/v1" as const,
    ok: true as const,
    status: read.status,
    works: works.map((work): WorkIndexRow => ({ ...work, memberTaskIds: members.get(work.taskId)!.sort() })),
    watermark: read.watermark,
    sourceRevision: read.sourceRevision,
    warnings: read.warnings,
  };
}

/** The roots (declared, or a top-level task with children) with their subtree counts, newest activity first. */
function workRows(rows: readonly TaskIndexProjectionRow[]): WorkListRow[] {
  const children = new Map<string, TaskIndexProjectionRow[]>();
  for (const row of rows) {
    if (row.parentTaskId === null) continue;
    const siblings = children.get(row.parentTaskId);
    if (siblings) siblings.push(row);
    else children.set(row.parentTaskId, [row]);
  }
  return rows
    .filter((row) => isWorkRoot(row.taskClass, row.parentTaskId, children.get(row.taskId)?.length ?? 0))
    .map((row): WorkListRow => {
      const counts = emptyScopeCounts(),
        seen = new Set([row.taskId]),
        members: TaskIndexProjectionRow[] = [],
        pending = [...(children.get(row.taskId) ?? [])];
      let lastActivityAt = row.updatedAt;
      while (pending.length) {
        const member = pending.shift()!;
        if (seen.has(member.taskId)) continue;
        seen.add(member.taskId);
        members.push(member);
        if (member.updatedAt > lastActivityAt) lastActivityAt = member.updatedAt;
        const below = children.get(member.taskId) ?? [];
        if (below.length === 0) counts[scopeStatus(member.status)] += 1;
        pending.push(...below);
      }
      return {
        taskId: row.taskId,
        title: row.title,
        status: derivedWorkRootStatus(row, members, true),
        root: row.taskClass === "work" ? "declared" : "derived",
        parentTaskId: row.parentTaskId,
        taskCount: members.length,
        counts,
        lastActivityAt,
      };
    })
    .sort(
      (left, right) =>
        right.lastActivityAt.localeCompare(left.lastActivityAt) || left.taskId.localeCompare(right.taskId),
    );
}

export function workShowFromProjection(projection: TaskProjection, input: { readonly taskId: string }) {
  const scope = workspaceStructureFromProjection(projection, { rootTaskId: input.taskId, limit: 500 }),
    packagePath = projection.read(input.taskId).packagePath,
    plan = packagePath === null ? null : projection.readDocument(`${packagePath}/task_plan.md`).document;
  return {
    schema: "work-show/v1" as const,
    root: scope.root,
    goal: plan === null ? null : planGoalSummary(plan.body),
    counts: scope.counts,
    scope: scope.scope,
    groups: scope.groups,
    openTasks: scope.tasks.filter(({ status }) => !isTerminalStatus(status)),
    truncated: scope.page.nextCursor !== null,
    status: scope.status,
    watermark: scope.watermark,
    sourceRevision: scope.sourceRevision,
  };
}

export function renderWorkPayload(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (record.schema === "work-list/v1") {
    const rows = (record.rows as readonly WorkListRow[]).map((row) =>
      [
        row.taskId,
        row.status,
        row.root,
        `${row.taskCount} tasks`,
        renderCounts(row.counts),
        row.lastActivityAt,
        row.title,
      ].join("\t"),
    );
    return [
      "works:",
      rows.join("\n") || "(none) — create one with ha work create --title <name>",
      `count=${String(record.count)}  status=${String(record.status)}  sourceRevision=${String(record.sourceRevision)}`,
      "next: ha work show <task-id> · ha task create --work <task-id> --title <title>",
    ].join("\n");
  }
  if (record.schema !== "work-show/v1") return null;
  const root = record.root as WorkspaceScopeTaskRow,
    scope = record.scope as { readonly descendantCount: number; readonly executableLeafCount: number },
    open = record.openTasks as readonly WorkspaceScopeTaskRow[],
    groups = record.groups as readonly WorkspaceScopeTaskRow[];
  return [
    `work ${root.taskId} [${root.status}] ${root.title}`,
    `goal: ${typeof record.goal === "string" ? record.goal : "(task_plan.md states no Goal or Mission)"}`,
    `tasks: ${scope.descendantCount} in the subtree, ${scope.executableLeafCount} leaves — ${renderCounts(
      record.counts as WorkspaceScopeStatusCounts,
    )}`,
    ...(groups.length ? ["groups:", ...groups.map((row) => `- ${row.taskId} [${row.status}] ${row.title}`)] : []),
    "open tasks:",
    ...(open.length ? open.map((row) => `- ${row.taskId} [${row.status}] ${row.title}`) : ["- (none)"]),
    ...(record.truncated === true ? ["- …more leaves than one read returns; use ha task list --parent"] : []),
    `next: ha task create --work ${root.taskId} --title <title> · ha agenda --work ${root.taskId}`,
  ].join("\n");
}

function renderCounts(counts: WorkspaceScopeStatusCounts): string {
  return (Object.keys(counts) as (keyof WorkspaceScopeStatusCounts)[])
    .map((key) => `${key} ${counts[key]}`)
    .join(" · ");
}

export function readWork(cell: TaskQueryCell, action: RepoTaskAction, binding: RepoCellBinding): WriteReceipt {
  const taskId = action.kind === "work-show" ? cell.requiredCellText(action.taskId, "taskId") : null;
  if (taskId !== null && !cell.projection.readTaskExists(taskId))
    throw cell.cellCodedError("task_not_found", `No task ${taskId}; list works with ha work list.`);
  const payload =
      taskId === null
        ? workListFromProjection(cell.projection, {
            all: action.all === true,
            ...(action.limit === undefined ? {} : { limit: Number(action.limit) }),
          })
        : workShowFromProjection(cell.projection, { taskId }),
    receipt = cell.readResult(
      cell.operationId(action, binding, cell.input.repoId, payload.sourceRevision),
      payload,
      payload.sourceRevision,
      null,
      payload,
    );
  return { ...receipt, ...payload } as WriteReceipt;
}
