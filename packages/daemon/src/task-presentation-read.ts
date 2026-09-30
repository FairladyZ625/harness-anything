import { isWorkRoot, type TaskProjectionQueries, type TaskProjectionListQuery } from "@harness-anything/kernel";
import { derivedWorkRootStatus } from "./workspace-scope-read.ts";

/** Display reads only. Command admission and lifecycle transitions keep the original projection. */
export function taskPresentationReads(
  projection: TaskProjectionQueries,
): Pick<TaskProjectionQueries, "read" | "list" | "readTaskIndex"> {
  function statuses() {
    const read = projection.readTaskIndex({ workSubtreesOnly: true }),
      children = new Map<string, (typeof read.rows)[number][]>(),
      changed = new Map<string, (typeof read.rows)[number]["status"]>();
    for (const row of read.rows) {
      if (row.parentTaskId === null) continue;
      const siblings = children.get(row.parentTaskId) ?? [];
      siblings.push(row);
      children.set(row.parentTaskId, siblings);
    }
    for (const root of read.rows) {
      if (!isWorkRoot(root.taskClass, root.parentTaskId, children.get(root.taskId)?.length ?? 0)) continue;
      const members: (typeof read.rows)[number][] = [],
        seen = new Set([root.taskId]),
        pending = [...(children.get(root.taskId) ?? [])];
      while (pending.length) {
        const member = pending.pop()!;
        if (seen.has(member.taskId)) continue;
        seen.add(member.taskId);
        members.push(member);
        pending.push(...(children.get(member.taskId) ?? []));
      }
      const status = derivedWorkRootStatus(root, members, true);
      if (status !== root.status) changed.set(root.taskId, status);
    }
    return changed;
  }
  const read: TaskProjectionQueries["read"] = (taskId) => {
    const raw = projection.read(taskId),
      task = raw.snapshot.task;
    if (!task) return raw;
    const status = statuses().get(taskId);
    return status === undefined ? raw : { ...raw, snapshot: { ...raw.snapshot, task: { ...task, status } } };
  };
  const readTaskIndex: TaskProjectionQueries["readTaskIndex"] = (query = {}) => {
    const changed = statuses();
    if (changed.size === 0) return projection.readTaskIndex(query);
    const { status, ...filters } = query;
    const limit = query.limit ?? (query.cursor === undefined ? undefined : 100);
    let raw = projection.readTaskIndex(filters),
      cursor = raw.page?.nextCursor ?? null;
    const rows: (typeof raw.rows)[number][] = [];
    for (;;) {
      for (const row of raw.rows) {
        const display = { ...row, status: changed.get(row.taskId) ?? row.status };
        if (status === undefined || display.status === status) rows.push(display);
      }
      if (cursor === null || (limit !== undefined && rows.length > limit)) break;
      raw = projection.readTaskIndex({ ...filters, cursor });
      cursor = raw.page?.nextCursor ?? null;
    }
    const selected = presentationPage(rows, { ...query, pinnedFirst: false }, () => false);
    return { ...raw, rows: selected.rows, page: selected.page };
  };
  const list: TaskProjectionQueries["list"] = (query = {}) => {
    const changed = statuses();
    if (changed.size === 0) return projection.list(query);
    const { status, ...filters } = query;
    const limit = query.limit ?? (query.cursor === undefined ? undefined : 100);
    let raw = projection.list(filters),
      cursor = raw.page?.nextCursor ?? null;
    const selected: (typeof raw.rows)[number][] = [];
    for (;;) {
      for (const row of raw.rows) {
        const task = row.snapshot.task,
          presented = changed.get(row.taskId);
        const display =
          task && presented !== undefined
            ? { ...row, snapshot: { ...row.snapshot, task: { ...task, status: presented } } }
            : row;
        if (status === undefined || display.snapshot.task?.status === status) selected.push(display);
      }
      // Matching rows grow monotonically; the underlying reader's nextCursor signals exhaustion.
      if (cursor === null || (limit !== undefined && selected.length > limit)) break;
      raw = projection.list({ ...filters, cursor });
      cursor = raw.page?.nextCursor ?? null;
    }
    const page = presentationPage(selected, query, (row) => row.snapshot.task?.pinned === true);
    return { ...raw, rows: page.rows, ...(page.page ? { page: page.page } : {}) };
  };
  return { read, readTaskIndex, list };
}

function presentationPage<T extends { readonly taskId: string }>(
  rows: readonly T[],
  query: TaskProjectionListQuery,
  pinned: (row: T) => boolean,
) {
  if (query.limit === undefined && query.cursor === undefined) return { rows, page: null };
  const limit = query.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
    throw new Error("query page limit must be an integer between 1 and 500");
  const visible = rows.slice(0, limit),
    last = visible.at(-1);
  return {
    rows: visible,
    page: {
      limit,
      cursor: query.cursor ?? null,
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify(query.pinnedFirst ? [String(Number(pinned(last))), last.taskId] : [last.taskId]),
            ).toString("base64url")
          : null,
    },
  };
}
