import { useMemo, useState } from "react";
import type { SnapshotStatus, TaskRow } from "../../model/types";
import { BOARD_COLUMNS } from "../../model/types";
import { coordinationStatusCensus } from "../../model/status-census.ts";
import { sortTasksByCreatedDesc, taskCreatedAt } from "../../model/ledger-timeline.ts";
import { STATUS_META, StatusBadge } from "../badges.tsx";
import { t } from "../../i18n/index.tsx";
import { StreamBody, StreamEmpty, StreamExitButton, StreamTabs, streamTime } from "./streamParts.tsx";

/**
 * 总览「任务流」:合并原「现在在跑什么」与「任务流」两格。
 * 状态切换是**就地筛选**——点哪个状态,本格数据源换成该状态的任务瀑布流,
 * 路由不动;「去看板」是唯一的显式路由出口,带当前状态预置。
 * 计数口径 = coordinationStatusCensus(与侧栏摘要逐字同源)。
 * 排序 = task_bootstrapped 创建时间倒序;内部滚动,不截断。
 */
export function TaskStream({
  tasks,
  onOpenPreview,
  onGoBoard,
}: {
  tasks: ReadonlyArray<TaskRow>;
  onOpenPreview: (taskId: string) => void;
  onGoBoard: (status: SnapshotStatus) => void;
}) {
  const [status, setStatus] = useState<SnapshotStatus>("active");
  const census = useMemo(() => coordinationStatusCensus(tasks), [tasks]);
  const rows = useMemo(
    () => sortTasksByCreatedDesc(tasks.filter((task) => task.coordinationStatus === status)),
    [tasks, status],
  );

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <StreamTabs
          options={BOARD_COLUMNS.filter((column) => column !== "unknown").map((column) => ({
            key: column,
            label: STATUS_META[column].label,
            count: census.get(column) ?? 0,
          }))}
          value={status}
          onChange={setStatus}
          testIdOf={(column) => `overview-status-${column}`}
        />
        <StreamExitButton
          label={t("views.overviewView.goBoard")}
          title={t("views.overviewView.goBoardTitle", { status: STATUS_META[status].label })}
          onClick={() => onGoBoard(status)}
        />
      </div>
      {rows.length === 0 ? (
        <StreamEmpty>{t("views.overviewView.taskEmpty")}</StreamEmpty>
      ) : (
        <StreamBody testId="task-stream-rows">
          {rows.map((task) => (
            <button
              key={task.taskId}
              type="button"
              onClick={() => onOpenPreview(task.taskId)}
              title={`${task.taskId} · ${task.title}`}
              className="flex w-full items-center gap-2 rounded-md border border-border bg-surface-raised px-2 py-1 text-left transition-colors duration-100 [contain-intrinsic-size:auto_1.75rem] [content-visibility:auto] hover:border-accent/60"
            >
              <span className="shrink-0 text-[13px]" style={{ color: STATUS_META[task.coordinationStatus].color }}>
                {STATUS_META[task.coordinationStatus].icon}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text">{task.title}</span>
              <StatusBadge status={task.coordinationStatus} />
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-text-faint">{streamTime(taskCreatedAt(task))}</span>
            </button>
          ))}
        </StreamBody>
      )}
    </div>
  );
}
