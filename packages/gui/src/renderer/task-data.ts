import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { harnessClient, type TaskListSuccess, type TaskQueryFacets } from "./api-client.ts";
import { agendaQueryKeys } from "./agenda-data.ts";
import { runtimeQueryKeys } from "./agent-runtime-client.ts";
import { LEDGER_PROBE_FOCUS_REFETCH, QUERY_PACING_MS } from "./query-pacing.ts";
import { workspaceSummaryQueryKeys } from "./workspace-summary-data.ts";

export const TASK_LIST_PAGE_LIMIT = 500;

/**
 * 单次刷新的续读页预算(受控快读水化的上限保护,F-45297836):水化沿游标顺序补页,
 * 每页严格等上一页回来,单次刷新最多这么多个分页请求;预算耗尽时切面保持 pending,
 * 交回探针节拍(2s)继续——断网或坏游标最坏也只是「每个探针节拍一串有界请求」,
 * 不存在失控 drain。12 页 × 500 行 = 6,000 行,是当前台账规模(2,826)的两倍余量。
 */
export const HYDRATION_PAGE_BUDGET = 12;

/**
 * 首屏活跃切片的状态集:daemon 台账状态词(taskStatusWords,daemon 协议词表)里的
 * 全部非终态。done/cancelled 是终态;unknown 不是 daemon 过滤词,认不出状态的行由
 * 完整切面兜住,切片不追。
 */
const ACTIVE_TASK_STATUSES = ["planned", "active", "submitted", "blocked", "in_review"] as const;

export const taskQueryKeys = {
  all: (repoId: string) => ["tasks", repoId] as const,
  list: (repoId: string) => ["tasks", repoId, "list"] as const,
  activeSlice: (repoId: string) => ["tasks", repoId, "active-slice"] as const,
  wip: (repoId: string) => ["tasks", repoId, "wip"] as const,
  document: (repoId: string, taskId: string, path: string) => ["tasks", repoId, taskId, "document", path] as const,
  documentList: (repoId: string, taskId: string) => ["tasks", repoId, taskId, "document-list"] as const,
};

export function useTaskWipQuery(repoId: string | null, enabled: boolean) {
  const selectedRepoId = repoId ?? "unselected";
  return useQuery({
    queryKey: taskQueryKeys.wip(selectedRepoId),
    queryFn: () => harnessClient.getTaskWip({ repoId: selectedRepoId }),
    enabled: repoId !== null && enabled,
    staleTime: 10_000,
  });
}

export function taskListQuery(repoId: string) {
  return {
    queryKey: taskQueryKeys.list(repoId),
    queryFn: () => readTaskList(repoId),
    staleTime: 10_000,
    refetchInterval: QUERY_PACING_MS.ledgerProbe,
    // This list is the one ledger probe: its interval and an immediate re-probe on focus are what
    // advance the cut, and a changed cut fans out to every dependent read (invalidateLedgerDependents).
    // Dependent reads therefore need neither their own timer nor their own focus refetch.
    refetchOnWindowFocus: LEDGER_PROBE_FOCUS_REFETCH,
  };
}

/**
 * 台账读取形态(W6 Goal 的演进版:支持 cursor/limit 的读面不得被消费成「失控 drain」)。
 *
 * 刷新先按缓存里的上一份切面决定第一读(游标续读 / 重启 / `changedAfterRevision` 增量),
 * 然后在**同一刷新内**沿游标顺序把剩余页拉完——受控快读水化(F-45297836:旧形态把
 * 续读交给 2s 探针节拍,6 页要 10~12s)。每页严格等上一页回来,单次刷新的页请求
 * 上限是 `HYDRATION_PAGE_BUDGET`,这就是防失控 drain 的门;预算耗尽就带着 pending
 * 切面交回探针节拍继续。三种首读形态:
 *   - 上一份还带着 `page.nextCursor` → 沿游标续读下一页(cursor 就是续读状态,
 *     存在 react-query 缓存里,不需要模块级可变变量);
 *   - 没有上一份 → 读第一页,重新开始水化;
 *   - 上一份存在(ready 或 pending)→ 读一页 `changedAfterRevision` 增量;
 *     增量被截断时同样进入快读续读。
 *
 * 投影追赶中(cut pending)与 ready 同样走增量:daemon 报的 watermark 就是它已
 * 应用到的位置,rows 相对该水位完整,增量读从上一水位起即可;pending 期间不再
 * 每 2s 重读整页 500 行。`status` 原样透传,侧栏继续显示「正在追赶」。
 * 未读完的切面 `status` 一律是 `pending`,每行 freshness 落成 `stale-but-usable`
 * (task-adapter),所以"还没读完"在界面上是显形的。
 */
export async function readTaskList(repoId: string, previous?: TaskListSuccess): Promise<TaskListSuccess> {
  const resumeCursor = previous?.page?.nextCursor ?? null;
  let cut: TaskListSuccess;
  if (previous && resumeCursor !== null) {
    cut = joinLedgerCut(previous, await readTaskPage(repoId, { cursor: resumeCursor }), "resume");
  } else if (!previous) {
    cut = joinLedgerCut(undefined, await readTaskPage(repoId, {}), "restart");
  } else {
    const delta = await readTaskPage(repoId, { changedAfterRevision: previous.watermark });
    const regressed = delta.watermark < previous.watermark || delta.sourceRevision < previous.sourceRevision;
    cut = regressed
      ? joinLedgerCut(undefined, await readTaskPage(repoId, {}), "restart")
      : joinLedgerCut(previous, delta, "delta");
  }
  // 受控快读水化:沿游标顺序补完剩余页。终止条件:预算耗尽(pages 每轮严格 +1,
  // 上界 HYDRATION_PAGE_BUDGET)或读完成(nextCursor 为空);任何一页出错整个
  // 刷新失败,无内部重试,交回 react-query 的重试与下一探针节拍。
  for (let pages = 1; cut.page?.nextCursor != null && pages < HYDRATION_PAGE_BUDGET; pages += 1) {
    cut = joinLedgerCut(cut, await readTaskPage(repoId, { cursor: cut.page.nextCursor }), "resume");
  }
  return cut;
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
    invalidRows: read.invalidRows,
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
 * 首屏合并:完整切面在前、活跃切片补缺。同 id 冲突时**完整切面的行胜出**——完整
 * 切面由探针增量持续更新,切片在切面 ready 后就停读,让切片胜出会把它覆盖的行
 * 冻结在停读那一刻。两侧都未落地时返回空数组,首屏行集随任一侧到达渐进成形。
 */
export function mergeTaskRows(
  ledgerRows: TaskListSuccess["rows"] | undefined,
  sliceRows: TaskListSuccess["rows"] | undefined,
): TaskListSuccess["rows"] {
  const rows = new Map((sliceRows ?? []).map((row) => [row.taskId, row]));
  for (const row of ledgerRows ?? []) rows.set(row.taskId, row);
  return [...rows.values()].sort((left, right) => compareTaskId(left.taskId, right.taskId));
}

/**
 * 首屏活跃切片(状态下推):每个非终态一页窄读并行发出,`status` 过滤下推进
 * daemon SQL,不把全量台账拉到前端再筛。它只是首屏加速器,不追自己的游标——
 * 非终态行数远小于一页;真超页的部分由紧接着的完整水化(单刷新内拉完)接住。
 */
export async function readActiveTaskSlice(repoId: string): Promise<TaskListSuccess["rows"]> {
  const pages = await Promise.all(
    ACTIVE_TASK_STATUSES.map((status) => harnessClient.getTasks({ repoId, status, limit: TASK_LIST_PAGE_LIMIT })),
  );
  return mergeTaskRows(
    undefined,
    pages.flatMap((page) => page.rows),
  );
}

/**
 * 首屏活跃切片查询:只在台账切面未读完(尚无切面或 pending)期间读取,ready 后
 * 停读(enabled=false),行集由完整切面接管(切片行集是它的子集)。自己不带
 * 计时器:挂载期间的重读由台账 cut 前进的扇出带进来;`staleTime: 0` 让重新启用
 * (切面回退重水化)时必定重读,不拿停读前的旧切片冒充。
 */
export function activeTasksQuery(repoId: string, hydrationPending: boolean) {
  return {
    queryKey: taskQueryKeys.activeSlice(repoId),
    queryFn: () => readActiveTaskSlice(repoId),
    enabled: hydrationPending,
    staleTime: 0,
  };
}

export function useActiveTasksQuery(repoId: string | null, hydrationPending: boolean) {
  return useQuery(activeTasksQuery(repoId ?? "unselected", repoId !== null && hydrationPending));
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
    queryClient.invalidateQueries({ queryKey: agendaQueryKeys.read(repoId), refetchType: "active" }),
    queryClient.invalidateQueries({ queryKey: workspaceSummaryQueryKeys.read(repoId), refetchType: "active" }),
    queryClient.invalidateQueries({ queryKey: runtimeQueryKeys.dispatchesAll(repoId), refetchType: "active" }),
    queryClient.invalidateQueries({ queryKey: runtimeQueryKeys.overviewAll(repoId), refetchType: "active" }),
    // 会话页读面(session groups / squad runs / run 详情 / 选中 session / agent inspector 的
    // 相关派工)骑同一台探针:runtime 会话生命周期事件是 canonical 事件,同样推进这里的
    // cut,所以新派工与 running→succeeded 变化都由这次扇出带进挂载中的列表。
    queryClient.invalidateQueries({ queryKey: runtimeQueryKeys.sessionAll(repoId), refetchType: "active" }),
    queryClient.invalidateQueries({ queryKey: runtimeQueryKeys.sessionGroupsAll(repoId), refetchType: "active" }),
    queryClient.invalidateQueries({ queryKey: runtimeQueryKeys.squadRunsAll(repoId), refetchType: "active" }),
    queryClient.invalidateQueries({ queryKey: runtimeQueryKeys.squadRunDetailAll(repoId), refetchType: "active" }),
    queryClient.invalidateQueries({ queryKey: runtimeQueryKeys.relatedDispatchesAll(repoId), refetchType: "active" }),
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

export function useTaskCompletionQuery(repoId: string, taskId: string) {
  return useQuery({
    queryKey: ["tasks", repoId, taskId, "completion"],
    queryFn: () => harnessClient.getTaskCompletion({ repoId, taskId }),
    staleTime: 10_000,
  });
}
