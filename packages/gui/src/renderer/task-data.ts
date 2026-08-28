import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { harnessClient, type TaskListSuccess, type TaskQueryFacets } from "./api-client.ts";
import { workspaceSummaryQueryKeys } from "./workspace-summary-data.ts";

export const LEDGER_REFRESH_INTERVAL_MS = 2_000;
export const TASK_LIST_PAGE_LIMIT = 500;

export const taskQueryKeys = {
  all: (repoId: string) => ["tasks", repoId] as const,
  list: (repoId: string) => ["tasks", repoId, "list"] as const,
  document: (repoId: string, taskId: string, path: string) => ["tasks", repoId, taskId, "document", path] as const,
  documentList: (repoId: string, taskId: string) => ["tasks", repoId, taskId, "document-list"] as const,
};

export function taskListQuery(repoId: string) {
  return {
    queryKey: taskQueryKeys.list(repoId),
    queryFn: () => readTaskList(repoId),
    staleTime: 10_000,
    refetchInterval: LEDGER_REFRESH_INTERVAL_MS,
    refetchOnWindowFocus: "always" as const,
  };
}

/**
 * 台账读取形态(W6 Goal:支持 cursor/limit 的读面不得被消费成「一次拉 500 直到拉完」)。
 *
 * 一次刷新最多发一个 `repo.tasks.list` 请求,三种形态由缓存里的上一份切面决定:
 *   - 上一份还带着 `page.nextCursor` → 沿游标续读下一页(cursor 就是续读状态,
 *     存在 react-query 缓存里,不需要模块级可变变量);
 *   - 没有上一份、或上一份不是 ready → 读第一页,重新开始水化;
 *   - 上一份完整且 ready → 读一页 `changedAfterRevision` 增量。
 *
 * 未读完的切面 `status` 一律是 `pending`:侧栏据此显示「正在追赶 r{sourceRevision}」,
 * 每行 freshness 落成 `stale-but-usable`(task-adapter),所以"还没读完"在界面上是显形的。
 */
export async function readTaskList(repoId: string, previous?: TaskListSuccess): Promise<TaskListSuccess> {
  const resumeCursor = previous?.page?.nextCursor ?? null;
  if (previous && resumeCursor !== null) {
    return joinLedgerCut(previous, await readTaskPage(repoId, { cursor: resumeCursor }), "resume");
  }
  if (!previous || previous.status !== "ready") {
    return joinLedgerCut(undefined, await readTaskPage(repoId, {}), "restart");
  }
  const delta = await readTaskPage(repoId, { changedAfterRevision: previous.watermark });
  const regressed = delta.watermark < previous.watermark || delta.sourceRevision < previous.sourceRevision;
  if (delta.status !== "ready" || regressed) {
    return joinLedgerCut(undefined, await readTaskPage(repoId, {}), "restart");
  }
  return joinLedgerCut(previous, delta, "delta");
}

type LedgerReadFacets = Pick<TaskQueryFacets, "changedAfterRevision" | "cursor">;

async function readTaskPage(repoId: string, facets: LedgerReadFacets): Promise<TaskListSuccess> {
  return harnessClient.getTasks({ repoId, ...facets, limit: TASK_LIST_PAGE_LIMIT });
}

/**
 * 把新读到的一页并进已有切面。不变量:**rows 相对所报 watermark 是完整的**——这是
 * 后续 `changedAfterRevision` 增量读正确的前提。原实现靠"整段读必须落在同一个 cut,
 * 否则抛错重来"保证它;跨刷新续读不可能落在同一个 cut,所以改成:
 *
 *   - 未读完(`resume`)或增量本身被截断时,watermark/sourceRevision 取 min,只担保
 *     最老的那个水位;只有"锚在 previous.watermark 上、且一页读完的增量"才推进水位。
 *   - 游标是不可变主键 task_id,续读期间任何已存在 task 的改动都不会被跳过;续读期间
 *     新建的 task 其 revision 必然大于所报水位,由随后的增量读补齐。
 */
function joinLedgerCut(
  previous: TaskListSuccess | undefined,
  read: TaskListSuccess,
  mode: "restart" | "resume" | "delta",
): TaskListSuccess {
  const complete = (read.page?.nextCursor ?? null) === null;
  const base = mode === "restart" ? undefined : previous;
  const rows = new Map((base?.rows ?? []).map((row) => [row.taskId, row]));
  for (const row of read.rows) rows.set(row.taskId, row);
  const advanced = base === undefined || (mode === "delta" && complete);
  const watermark = advanced ? read.watermark : Math.min(base.watermark, read.watermark);
  const sourceRevision = advanced ? read.sourceRevision : Math.min(base.sourceRevision, read.sourceRevision);
  return {
    ok: true,
    status: complete ? read.status : "pending",
    warnings: read.warnings,
    watermark,
    sourceRevision,
    rows: [...rows.values()].sort((left, right) => compareTaskId(left.taskId, right.taskId)),
    ...(complete || read.page === undefined ? {} : { page: read.page }),
  };
}

/** 台账行序:daemon 的 keyset 分页按 task_id 升序发页,合并后必须还是同一个序。 */
function compareTaskId(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

export function useTasksQuery(repoId: string | null) {
  const queryClient = useQueryClient(),
    selectedRepoId = repoId ?? "unselected",
    queryKey = taskQueryKeys.list(selectedRepoId);
  return useQuery({
    ...taskListQuery(selectedRepoId),
    queryFn: () => readTaskList(selectedRepoId, queryClient.getQueryData<TaskListSuccess>(queryKey)),
    enabled: repoId !== null,
  });
}

/**
 * 台账切面变化时只重取「当前挂载的视图正在观察」的查询(task_9d53606292)。
 *
 * `refetchType: "active"` 是 react-query v5 的默认值,这里写死是把它钉成契约:
 * 无观察者的查询只标记为 stale,下次真正挂载时才读,绝不在后台替没人看的视图
 * 掏一次全量投影。哪个查询该读由挂载点决定,不由这里的失效面决定。
 */
export async function invalidateLedgerDependents(queryClient: QueryClient, repoId: string): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: taskQueryKeys.all(repoId),
      predicate: (query) => query.queryKey[2] !== "list",
      refetchType: "active",
    }),
    queryClient.invalidateQueries({ queryKey: ["triadic", repoId], refetchType: "active" }),
    queryClient.invalidateQueries({ queryKey: workspaceSummaryQueryKeys.read(repoId), refetchType: "active" }),
  ]);
}

export function taskDocumentQuery(repoId: string, taskId: string, path: string) {
  return {
    queryKey: taskQueryKeys.document(repoId, taskId, path),
    queryFn: () => harnessClient.getTaskDocument({ repoId, taskId, path }),
    staleTime: 10_000,
  };
}

export function useTaskDocumentQuery(repoId: string, taskId: string, path: string | null) {
  return useQuery({ ...taskDocumentQuery(repoId, taskId, path ?? ""), enabled: path !== null });
}

/** 任务包文档清单(repo.tasks.documents.list):合同槽位之外,artifacts/ 等子目录文件也在此列。 */
export function taskDocumentListQuery(repoId: string, taskId: string) {
  return {
    queryKey: taskQueryKeys.documentList(repoId, taskId),
    queryFn: () => harnessClient.getTaskDocuments({ repoId, taskId }),
    staleTime: 10_000,
  };
}

export function useTaskDocumentListQuery(repoId: string, taskId: string | null) {
  return useQuery({ ...taskDocumentListQuery(repoId, taskId ?? ""), enabled: taskId !== null });
}
