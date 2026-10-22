import { taskPresentationReads } from "./task-presentation-read.ts";
import type {
  TaskIndexProjectionRow,
  TaskProjection,
  TaskV2,
  WriteReceiptDraft as WriteReceipt,
} from "@harness-anything/kernel";
import { isTerminalStatus, isWorkRoot } from "@harness-anything/kernel";
import { planGoalSummary } from "./dispatch-causal-context.ts";
import type { TaskQueryCell } from "./repo-cell-task-query.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import {
  emptyScopeCounts,
  scopeStatus,
  workRootOf,
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
  const read = taskPresentationReads(projection).readTaskIndex({ activePackagesOnly: true }),
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

/**
 * The one line a create receipt owes the reader: which work the task landed under (id and title,
 * plus that work's stated goal), or, for a task that landed nowhere, the answer plus the work roots
 * it could join. A landed task also hears which other open works match its title best, each with
 * the move command that re-hangs it, so a mismatched placement is corrected at creation time
 * instead of surfacing later as an unexplainable grouping. Both the live create paths and a replay
 * of the create event render through this function, so a retried receipt cannot say less than the
 * first one did.
 */
export function workReceiptLine(
  projection: Pick<TaskProjection, "read" | "readTaskIndex" | "readDocument">,
  task: Pick<TaskV2, "taskId" | "title" | "taskClass" | "metadata">,
): string {
  const parentTaskId = task.metadata?.parentTaskId ?? null,
    work = parentTaskId === null ? null : workRootOf(projection, parentTaskId);
  if (work !== null) {
    const goal = workGoal(projection, work.taskId),
      candidates = candidateWorkLines(projection, task.taskId, task.title, work.taskId, true);
    return [
      `\nwork: ${work.taskId} ${work.title}`,
      ...(goal === null ? [] : [`goal: ${goal}`]),
      ...(candidates.length ? ["if this task does not belong to that work, move it now:", ...candidates] : []),
    ].join("\n");
  }
  if (task.taskClass === "work")
    return `\nwork: ${task.taskId} ${task.title} (new work root; add tasks with --work ${task.taskId})`;
  const candidates = candidateWorkLines(projection, task.taskId, task.title, null, false);
  return [
    "\nwork: none (standalone task)",
    ...(candidates.length ? ["candidate works:", ...candidates] : []),
    "next: ha work list",
  ].join("\n");
}

/** How many open works a receipt offers as move candidates; enough to choose, few enough to scan. */
const WORK_RECEIPT_CANDIDATE_LIMIT = 3,
  /** Title-screened works that earn a goal read, so relevance spans the pool while reads stay bounded. */
  WORK_RECEIPT_CANDIDATE_POOL = 8;

/**
 * Open, unfinished work roots a create could move to, most title/goal-similar first, each rendered
 * as the move command that re-hangs the task. The terminal filter runs on the presented status, so
 * a work whose subtree all finished never poses as a "move it now" target even while its raw root
 * status is still planned/active — the same rule `workListFromProjection` applies. `requireOverlap`
 * keeps a landed task's receipt quiet unless some other work actually shares words with the title;
 * a standalone create always hears the open roots. The pool is every open work root: the index's
 * `limit` pages by task id, so ranking a limited read would silently hide most of the ledger behind
 * its earliest ids. The task's own subtree never poses as a candidate — moving a task under itself
 * or a descendant is always a parent_cycle rejection, and the created task is itself a root at
 * receipt time (a nested work create) or by replay (a standalone task that grew child works), so a
 * self-subtree candidate would rank first on a perfect title match and always fail. The subtree is
 * excluded by walking children reads down from the task, not by widening the pool read: the pool
 * stays a roots-only read and the walk costs no rows at all for a childless task. Titles screen
 * first — no document reads — and only the shortlist reads task_plan.md goals for a repriced rank,
 * so goal-only matches surface without one document read per work root. Equal scores keep the
 * index's task-id order.
 */
function candidateWorkLines(
  projection: Pick<TaskProjection, "readTaskIndex" | "read" | "readDocument">,
  taskId: string,
  taskTitle: string,
  excludeTaskId: string | null,
  requireOverlap: boolean,
): string[] {
  const titleTokens = workReceiptTokens(taskTitle),
    excluded = new Set<string>(excludeTaskId === null ? [taskId] : [taskId, excludeTaskId]),
    below = [taskId];
  while (below.length) {
    for (const row of projection.readTaskIndex({
      parentTaskId: below.pop()!,
      activePackagesOnly: true,
      presentationStatus: true,
    }).rows)
      if (!excluded.has(row.taskId)) {
        excluded.add(row.taskId);
        below.push(row.taskId);
      }
  }
  const shortlist = projection
    .readTaskIndex({
      workRootsOnly: true,
      openOnly: true,
      activePackagesOnly: true,
      presentationStatus: true,
    })
    .rows.filter((row) => !excluded.has(row.taskId) && !isTerminalStatus(row.status))
    .map((row) => ({ row, titleScore: workReceiptOverlap(titleTokens, workReceiptTokens(row.title)) }))
    .sort((left, right) => right.titleScore - left.titleScore)
    .slice(0, WORK_RECEIPT_CANDIDATE_POOL);
  return shortlist
    .map(({ row, titleScore }) => ({
      row,
      score: titleScore + workReceiptOverlap(titleTokens, workReceiptTokens(workGoal(projection, row.taskId) ?? "")),
    }))
    .sort((left, right) => right.score - left.score)
    .filter((entry) => entry.score > 0 || !requireOverlap)
    .slice(0, WORK_RECEIPT_CANDIDATE_LIMIT)
    .map(({ row }) => `- ${row.taskId} ${row.title}: ha task move ${taskId} --parent ${row.taskId}`);
}

/** The work root's stated goal, from the same plan sections ha work show reads; null when unstated. */
function workGoal(projection: Pick<TaskProjection, "read" | "readDocument">, workTaskId: string): string | null {
  const packagePath = projection.read(workTaskId).packagePath;
  if (packagePath === null) return null;
  const plan = projection.readDocument(`${packagePath}/task_plan.md`).document;
  if (plan === null) return null;
  const goal = planGoalSummary(plan.body);
  return goal === null || goal.length <= 240 ? goal : `${goal.slice(0, 239)}…`;
}

/** Latin words plus CJK character bigrams: one token vocabulary over mixed-language titles and goals. */
function workReceiptTokens(text: string): Set<string> {
  const lowered = text.toLowerCase(),
    tokens = new Set<string>();
  for (const match of lowered.matchAll(/[a-z0-9][a-z0-9'.+-]*/gu)) tokens.add(match[0]);
  for (const match of lowered.matchAll(/\p{Script=Han}+/gu)) {
    const run = match[0];
    if (run.length === 1) {
      tokens.add(run);
      continue;
    }
    for (let index = 0; index < run.length - 1; index += 1) tokens.add(run.slice(index, index + 2));
  }
  return tokens;
}

function workReceiptOverlap(left: Set<string>, right: Set<string>): number {
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared;
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
  const read = taskPresentationReads(projection).readTaskIndex({ activePackagesOnly: true }),
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
        status: row.status,
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

/** Render the owner-facing work page from the same projection cut as work show. */
export function renderWorkExplainer(projection: TaskProjection, taskId: string): string {
  const payload = workShowFromProjection(projection, { taskId }),
    root = payload.root,
    open = payload.openTasks,
    goal = payload.goal ?? "No goal has been recorded in task_plan.md.",
    groups = payload.groups,
    counts = payload.counts;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(root.title)} | Work</title><style>body{margin:0;padding:24px;background:#faf7f0;color:#3d3833;font:16px/1.55 system-ui,sans-serif}main{max-width:1100px;margin:auto}header,section{border-top:1px solid #d8d0c4;padding:20px 0}h1{font-size:2rem;margin:0}h2{font-size:1.2rem}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid #d8d0c4}small{color:#746e65}</style></head><body><main><header><h1>${escapeHtml(root.title)}</h1><p>${escapeHtml(workStatusSentence(root.status, counts, open.length))}</p><small>${escapeHtml(root.taskId)} · ${root.status} · ${payload.sourceRevision}</small></header><section id="goal"><h2>Goal</h2><p>${escapeHtml(goal)}</p></section><section id="board"><h2>Task groups</h2>${groups.length ? `<ul>${groups.map((row) => `<li>${escapeHtml(row.taskId)} · ${escapeHtml(row.status)} · ${escapeHtml(row.title)}</li>`).join("")}</ul>` : "<p>No task groups.</p>"}</section><section id="open-tasks"><h2>Open tasks (${open.length})</h2>${open.length ? `<ul>${open.map((row) => `<li>${escapeHtml(row.taskId)} · ${escapeHtml(row.status)} · ${escapeHtml(row.title)}</li>`).join("")}</ul>` : "<p>No open tasks.</p>"}</section><section id="counts"><h2>Leaf task counts</h2><table><tbody>${Object.entries(
    counts,
  )
    .map(([status, count]) => `<tr><th>${escapeHtml(status)}</th><td>${count}</td></tr>`)
    .join(
      "",
    )}</tbody></table></section><footer><small>Generated from the daemon work projection at revision ${payload.sourceRevision}.</small></footer></main></body></html>`;
}

function workStatusSentence(
  status: TaskIndexProjectionRow["status"],
  counts: WorkspaceScopeStatusCounts,
  openCount: number,
): string {
  return `${status}: ${openCount} open tasks; ${counts.done} done, ${counts.blocked} blocked, ${counts.executing} executing.`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/gu,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

export function renderWorkPayload(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (record.schema === "work-list/v1") {
    // The title sits beside the id: a reader scanning the list must recognize the work before its
    // counts, and every other column stays in the order the JSON row declares it.
    const rows = (record.rows as readonly WorkListRow[]).map((row) =>
      [
        row.taskId,
        row.title,
        row.status,
        row.root,
        `${row.taskCount} tasks`,
        renderCounts(row.counts),
        row.lastActivityAt,
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
