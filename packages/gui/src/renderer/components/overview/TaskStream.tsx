import { useEffect, useMemo, useState } from "react";
import type { SnapshotStatus, TaskRow } from "../../model/types";
import type { WorkspaceSummaryRead } from "../../../api/renderer-dto.ts";
import { BOARD_COLUMNS } from "../../model/types";
import { sortTasksByCreatedDesc, taskCreatedAt } from "../../model/ledger-timeline.ts";
import { STATUS_META, StatusBadge } from "../badges.tsx";
import { t } from "../../i18n/index.tsx";
import { StreamBody, StreamEmpty, StreamExitButton, StreamTabs, streamTime } from "./streamParts.tsx";

/**
 * 流里每一段(主行集与「更新的」带)一次渲染这么多行,剩下的靠批量按钮显形——
 * 照抄本仓 BoardView 与命令面板的做法。两段共用同一批次大小:同一条流,同一套分批约定。
 *
 * 两段的规模都不是常数。主行集 = 选中状态的全部任务:本仓 1543 个任务时选 done 实测 1109 行、
 * planned 281 行。「更新的」这一段的组员是「比当前筛选里最新那行还新、且不属于该筛选状态」的任务,
 * 当前筛选一行都没有时阈值按设计退化为无阈值(那是为了让全新仓库刚建的第一条任务能浮现),
 * 于是全部有已知创建时间的任务都合格——本仓 1538 个任务时,那一档实测会渲染 1475 行。
 * 分批渲染把 DOM 节点数与任务总量脱钩,所以被推迟渲染的行是显形的、不是被吞掉的:
 * 主行集的真实总数由状态页签计数照抄 daemon census 报出,「更新的」带由标题报出;
 * 两段的按钮都报出剩余条数。
 */
const ROW_BATCH_SIZE = 12;

const ROW_CLASS =
  "flex w-full items-center gap-2 rounded-md border border-border bg-surface-raised px-2 py-1 text-left" +
  " transition-colors duration-100 [contain-intrinsic-size:auto_1.75rem] [content-visibility:auto]" +
  " hover:border-accent/60";

/** 流里的一行:主行集与「更新的」行集共用,两处的状态表达必须逐字一致。 */
function TaskStreamRow({ task, onOpenPreview }: { task: TaskRow; onOpenPreview: (taskId: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpenPreview(task.taskId)}
      title={`${task.taskId} · ${task.title}`}
      className={ROW_CLASS}
    >
      <span className="shrink-0 text-[13px]" style={{ color: STATUS_META[task.coordinationStatus].color }}>
        {STATUS_META[task.coordinationStatus].icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text">{task.title}</span>
      <StatusBadge status={task.coordinationStatus} />
      <span className="shrink-0 font-mono text-[11px] tabular-nums text-text-faint">
        {streamTime(taskCreatedAt(task))}
      </span>
    </button>
  );
}

/**
 * 「比当前筛选里最新那行更新」的任务 —— 状态筛选之外、但时间上排在你看得见的
 * 东西之前的那些行。刚 `ha task create` 出来的任务恒为 `planned`,默认筛选恒为
 * `active`,两者不相交(fact F-266F2F09);这一组就是让它不必先点标签也能被看见的行集。
 *
 * 判定只认**已知创建时间**:`createdAt` 为 null 的任务(没有可靠 task_bootstrapped
 * 的导入任务)无法被证明更新,按 ledger-timeline 的约定排尾部、不得从 ID 推时间,
 * 所以永不进这一组。当前筛选没有任何一行带已知创建时间(含筛选为空)时阈值退化为
 * 无阈值——那正是「全新仓库刚建第一条任务、active 为空」的场景。
 */
export function tasksAheadOfStatus(tasks: ReadonlyArray<TaskRow>, status: SnapshotStatus): TaskRow[] {
  const newestVisible = tasks.reduce<string | null>((newest, task) => {
    if (task.coordinationStatus !== status) return newest;
    const at = taskCreatedAt(task);
    return at !== null && (newest === null || at > newest) ? at : newest;
  }, null);
  return sortTasksByCreatedDesc(tasks.filter((task) => {
    if (task.coordinationStatus === status) return false;
    const at = taskCreatedAt(task);
    return at !== null && (newestVisible === null || at > newestVisible);
  }));
}

/**
 * 总览「任务流」:合并原「现在在跑什么」与「任务流」两格。
 * 状态切换是**就地筛选**——点哪个状态,本格数据源换成该状态的任务瀑布流,
 * 路由不动;「去看板」是唯一的显式路由出口,带当前状态预置。
 * Tab counts are rendered verbatim from the daemon workspace summary.
 * 排序 = task_bootstrapped 创建时间倒序;内部滚动,不截断。
 * 流首那一组是 `tasksAheadOfStatus` 派生的「更新的」行:没有独立筛选/排序/状态,
 * 不可能显示当前标签本来就会显示的行,当前标签已含最新行时它为空 —— 所以它不是
 * 第二条任务流(O-02),而是同一条流对「你还没看见更新的东西」的诚实交代。
 */
export function TaskStream({
  tasks,
  summary,
  onOpenPreview,
  onGoBoard,
}: {
  tasks: ReadonlyArray<TaskRow>;
  summary: WorkspaceSummaryRead["tasks"];
  onOpenPreview: (taskId: string) => void;
  onGoBoard: (status: SnapshotStatus) => void;
}) {
  const [status, setStatus] = useState<SnapshotStatus>("active");
  const rows = useMemo(
    () => sortTasksByCreatedDesc(tasks.filter((task) => task.coordinationStatus === status)),
    [tasks, status],
  );
  const ahead = useMemo(() => tasksAheadOfStatus(tasks, status), [tasks, status]);
  const [aheadVisible, setAheadVisible] = useState(ROW_BATCH_SIZE);
  const [rowsVisible, setRowsVisible] = useState(ROW_BATCH_SIZE);
  // 切换筛选会换掉两段的全部组员,展开状态不能跟着过去。
  useEffect(() => {
    setAheadVisible(ROW_BATCH_SIZE);
    setRowsVisible(ROW_BATCH_SIZE);
  }, [status]);
  const aheadShown = useMemo(() => ahead.slice(0, aheadVisible), [ahead, aheadVisible]);
  const aheadHidden = ahead.length - aheadShown.length;
  const rowsShown = useMemo(() => rows.slice(0, rowsVisible), [rows, rowsVisible]);
  const rowsHidden = rows.length - rowsShown.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2">
        <StreamTabs
          options={BOARD_COLUMNS.filter((column) => column !== "unknown").map((column) => ({
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
      {ahead.length > 0 && (
        <div
          data-testid="task-stream-ahead"
          className="shrink-0 rounded-md border border-dashed border-accent/50 bg-surface/40 p-1"
        >
          <p className="px-1 pb-1 font-mono text-[11px] text-text-muted" data-testid="task-stream-ahead-label">
            {t("views.overviewView.taskAhead", { count: ahead.length })}
          </p>
          <div className="max-h-[6rem] space-y-0.5 overflow-y-auto pr-1" data-testid="task-stream-ahead-rows">
            {aheadShown.map((task) => (
              <TaskStreamRow key={task.taskId} task={task} onOpenPreview={onOpenPreview} />
            ))}
            {aheadHidden > 0 && (
              <button
                type="button"
                data-testid="task-stream-ahead-more"
                onClick={() => setAheadVisible((count) => Math.min(count + ROW_BATCH_SIZE, ahead.length))}
                className="w-full px-1 py-1 text-center font-mono text-[11px] text-text-muted hover:text-text"
              >
                {t("views.overviewView.taskAheadShowMore", {
                  count: Math.min(ROW_BATCH_SIZE, aheadHidden),
                  remaining: aheadHidden,
                })}
              </button>
            )}
          </div>
        </div>
      )}
      {rows.length === 0 ? (
        <StreamEmpty>{t("views.overviewView.taskEmpty")}</StreamEmpty>
      ) : (
        <StreamBody testId="task-stream-rows">
          {rowsShown.map((task) => (
            <TaskStreamRow key={task.taskId} task={task} onOpenPreview={onOpenPreview} />
          ))}
          {rowsHidden > 0 && (
            <button
              type="button"
              data-testid="task-stream-more"
              onClick={() => setRowsVisible((count) => Math.min(count + ROW_BATCH_SIZE, rows.length))}
              className="w-full px-1 py-1 text-center font-mono text-[11px] text-text-muted hover:text-text"
            >
              {t("views.overviewView.taskShowMore", {
                count: Math.min(ROW_BATCH_SIZE, rowsHidden),
                remaining: rowsHidden,
              })}
            </button>
          )}
        </StreamBody>
      )}
    </div>
  );
}
