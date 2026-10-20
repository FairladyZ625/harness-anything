import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AgentTree, type AgentTreeNode } from "./agent-ui/AgentTree.tsx";
import { buildLineageTree, lineageDispatchOf, lineageTaskIdOf, lineageTaskIds } from "../model/lineage-tree.ts";
import { harnessClient } from "../api-client.ts";
import { t } from "../i18n/index.tsx";
import type { TaskRow } from "../model/types.ts";

/**
 * 血缘与成本树(dec_C0AF8CBBFFECF71F4F34FB76F9 CH4/W3-T1):工作页工作卡与任务详情关系页
 * 共用的实时树。一次 `repo.task.dispatches` 批量读拉齐根任务及全部子孙的派工轮,
 * buildLineageTree 组装 Work→Task→Squad/Worker 节点;任务节点点击开详情,派工节点点击
 * 开会话转录。读键挂在 ["dispatches", repoId] 族下,台账 cut 的扇出失效会一并刷新本树。
 * 节流:有运行中轮次(或任务切面报 executing)时 4s 轮询,否则停在 staleTime。
 */
const DISPATCH_PAGE_LIMIT = 500;

export function WorkLineageTree({
  repoId,
  rootTask,
  tasks,
  live,
  onOpenTask,
  onOpenSession,
  testId,
}: {
  readonly repoId: string;
  /** 树根:工作根任务(工作页)或当前任务(任务详情)。 */
  readonly rootTask: TaskRow;
  /** 全仓任务切面;子孙从中筛,树结构由 parentTaskId 递归得出。 */
  readonly tasks: readonly TaskRow[];
  /** 任务切面报告执行中(activeExecutionId)时保持轮询节拍。 */
  readonly live: boolean;
  /** 任务节点激活出口;缺省时任务节点不可激活。 */
  readonly onOpenTask?: (taskId: string) => void;
  /** 派工节点激活出口(会话转录);缺省时派工节点不可激活。 */
  readonly onOpenSession?: (runtimeSessionId: string) => void;
  readonly testId?: string;
}) {
  const taskIds = useMemo(
    () => lineageTaskIds(rootTask.taskId, tasks).slice(0, DISPATCH_PAGE_LIMIT),
    [rootTask.taskId, tasks],
  );
  const idsKey = taskIds.join("\u0000");
  const dispatches = useQuery({
    queryKey: ["dispatches", repoId, { batch: idsKey }],
    queryFn: () => harnessClient.getTaskDispatches({ repoId, taskIds, limit: DISPATCH_PAGE_LIMIT }),
    staleTime: 4_000,
    refetchInterval: (query) =>
      live || (query.state.data?.dispatches ?? []).some((row) => row.status === "running") ? 4_000 : false,
  });
  const rows = useMemo(() => dispatches.data?.dispatches ?? [], [dispatches.data]);

  const activate = useMemo(() => {
    if (onOpenTask === undefined && onOpenSession === undefined) return undefined;
    return (node: AgentTreeNode) => {
      const taskId = lineageTaskIdOf(node.id);
      if (taskId !== null) {
        onOpenTask?.(taskId);
        return;
      }
      const row = lineageDispatchOf(node.id, rows);
      if (row !== null) onOpenSession?.(row.runtimeSessionId);
    };
  }, [onOpenTask, onOpenSession, rows]);

  if (dispatches.isPending)
    return (
      <p
        className="animate-pulse ui-meta text-text-faint"
        data-testid={testId !== undefined ? `${testId}-pending` : undefined}
      >
        {t("views.lineage.reading")}
      </p>
    );
  if (dispatches.isError)
    return (
      <p
        className="ui-meta leading-5 text-danger"
        data-testid={testId !== undefined ? `${testId}-error` : undefined}
        role="alert"
      >
        {t("views.lineage.readError", { message: dispatches.error.message })}
      </p>
    );

  const root = buildLineageTree({ rootTask, tasks, dispatches: rows, nowMs: Date.now() });
  // 批次读才带 page;单任务/member 读面没有分页字段,直接不提示截断。
  const truncated =
    dispatches.data !== undefined && "page" in dispatches.data && dispatches.data.page.nextCursor != null;
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid={testId}>
      <AgentTree root={root} onNodeActivate={activate} testId={testId !== undefined ? `${testId}-tree` : undefined} />
      {truncated && <p className="m-0 ui-micro text-text-faint">{t("views.lineage.truncated")}</p>}
    </div>
  );
}
