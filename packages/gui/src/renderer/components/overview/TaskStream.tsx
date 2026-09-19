import { useMemo, useState } from "react";
import { PushPin } from "@phosphor-icons/react";
import type { SnapshotStatus, TaskRow } from "../../model/types";
import type { WorkspaceSummaryRead } from "../../../api/renderer-dto.ts";
import { BOARD_COLUMNS } from "../../model/types";
import { sortTasksByCreatedDesc, taskCreatedAt } from "../../model/ledger-timeline.ts";
import { STATUS_META, StatusBadge } from "../badges.tsx";
import { t } from "../../i18n/index.tsx";
import { StreamBody, StreamEmpty, StreamExitButton, StreamTabs, streamTime } from "./streamParts.tsx";

/**
 * 完整渲染,不分批(2026-08-25 泽宇裁决:性能顾虑用按需渲染解决,不转嫁给用户点击)。
 * 每行带 content-visibility:auto:离屏行的布局与绘制由渲染器跳过,DOM 仍是全量,
 * 行集的真实总数由状态页签计数照抄 daemon census 报出。
 *
 * 两段的规模都不是常数。主行集 = 选中状态的全部任务:本仓 1656 个任务时选 done 实测 1165 行。
 * 「更新的」这一段的组员是「比当前筛选里最新那行还新、且不属于该筛选状态」的任务,
 * 当前筛选一行都没有时阈值按设计退化为无阈值(那是为了让全新仓库刚建的第一条任务能浮现),
 * 于是全部有已知创建时间的任务都合格。
 */
const ROW_CLASS =
  "flex w-full items-center gap-2 rounded-md border border-border bg-surface-raised px-2 py-1 text-left" +
  " transition-colors duration-100 [contain-intrinsic-size:auto_1.75rem] [content-visibility:auto]" +
  " hover:border-accent/60";

/** 流里的一行:主行集与「更新的」行集共用,两处的状态表达必须逐字一致。 */
function TaskStreamRow({
  task,
  onOpenPreview,
  onSetPin,
}: {
  task: TaskRow;
  onOpenPreview: (taskId: string) => void;
  onSetPin?: (task: Pick<TaskRow, "taskId">, pinned: boolean) => void;
}) {
  const pinned = task.pinned === true;
  return (
    <div className={ROW_CLASS}>
      <button
        type="button"
        onClick={() => onOpenPreview(task.taskId)}
        title={`${task.taskId} · ${task.title}`}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <span className="shrink-0 ui-body" style={{ color: STATUS_META[task.coordinationStatus].color }}>
          {STATUS_META[task.coordinationStatus].icon}
        </span>
        <span className="min-w-0 flex-1 truncate ui-body font-medium text-text">{task.title}</span>
        <StatusBadge status={task.coordinationStatus} />
        <span className="shrink-0 font-mono ui-micro tabular-nums text-text-faint">
          {streamTime(taskCreatedAt(task))}
        </span>
      </button>
      {onSetPin ? (
        <button
          type="button"
          data-testid={`overview-pin-toggle-${task.taskId}`}
          onClick={() => onSetPin(task, !pinned)}
          aria-pressed={pinned}
          title={pinned ? t("views.overviewView.unpinTitle") : t("views.overviewView.pinTitle")}
          className={`inline-flex shrink-0 items-center justify-center rounded p-0.5 ui-body hover:bg-surface ${
            pinned ? "text-accent" : "text-text-faint hover:text-text-muted"
          }`}
        >
          <PushPin weight={pinned ? "fill" : "bold"} />
        </button>
      ) : pinned ? (
        <PushPin weight="fill" className="shrink-0 ui-body text-accent" />
      ) : null}
    </div>
  );
}

/**
 * 总览「任务流」:合并原「现在在跑什么」与「任务流」两格。
 * 状态切换是**就地筛选**——点哪个状态,本格数据源换成该状态的任务瀑布流,
 * 路由不动;「去看板」是唯一的显式路由出口,带当前状态预置。
 * Tab counts are rendered verbatim from the daemon workspace summary, one tab per
 * BOARD_COLUMNS entry —— 与看板同一列集合,包括 unknown:投影认不出状态的行在总览
 * 里同样不隐藏(与「未投影只沉底、不消失」同一条诚实边界)。
 * 排序 = task_bootstrapped 创建时间倒序;内部滚动,不截断。
 */
export function TaskStream({
  tasks,
  summary,
  onOpenPreview,
  onGoBoard,
  onSetPin,
}: {
  tasks: ReadonlyArray<TaskRow>;
  summary: WorkspaceSummaryRead["tasks"];
  onOpenPreview: (taskId: string) => void;
  onGoBoard: (status: SnapshotStatus) => void;
  onSetPin?: (task: Pick<TaskRow, "taskId">, pinned: boolean) => void;
}) {
  const [status, setStatus] = useState<SnapshotStatus>("active");
  const rows = useMemo(
    () =>
      sortTasksByCreatedDesc(
        tasks.filter((task) => task.packageDisposition === "active" && task.coordinationStatus === status),
      ),
    [tasks, status],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2">
        <StreamTabs
          options={BOARD_COLUMNS.map((column) => ({
            key: column,
            label: STATUS_META[column].label,
            count: summary.byStatus[column],
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
            <TaskStreamRow key={task.taskId} task={task} onOpenPreview={onOpenPreview} onSetPin={onSetPin} />
          ))}
        </StreamBody>
      )}
    </div>
  );
}
