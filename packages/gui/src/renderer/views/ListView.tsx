import { memo, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Lock, PushPin, Star } from "@phosphor-icons/react";
import type { TaskRow } from "../model/types";
import { isExternal, isTerminal } from "../model/types";
import { StatusTag } from "../components/primitives/StatusTag";
import { DenseRow } from "../components/primitives/DenseRow";
import { CompletedDivider } from "../components/primitives/CompletedDivider.tsx";
import { sortByRecentThenPinAndFavoritesFirst } from "../model/taskFilters";
import { t } from "../i18n/index.tsx";
import { relativeTime } from "../sessions-model";

/** 列表行 windowing:单行 40px + 分隔线(标准 §3 v2);实测由 measureElement 收敛。 */
const ROW_ESTIMATE_PX = 41;
const ROW_OVERSCAN = 12;

/**
 * 任务列表(标准 §2.4 列表页 v2):回答「我要找某个任务」。搜索与筛选由看板的
 * TaskFilterBar 提供(本视图只作为看板的列表布局渲染);行用 DenseRow、状态用
 * 有底色的 StatusTag,默认序与看板卡片同一实现(W8:lastKnownAt 倒序 + pin →
 * 收藏置顶);终态(完成/取消)一律沉底,在「已完成 N · 已取消 N」分隔线之后
 * 照常显示(§1.4 v2,不折叠成「展开」)。整表 windowing:DOM 行数与总量解耦,无分页。
 */
const TaskListRow = memo(function TaskListRow({
  task,
  onSelect,
  isFavorite,
  onToggleFavorite,
  onSetPin,
}: {
  task: TaskRow;
  onSelect: (id: string) => void;
  isFavorite: boolean;
  onToggleFavorite: (id: string) => void;
  onSetPin?: (task: TaskRow, pinned: boolean) => void;
}) {
  const pinned = task.pinned === true;
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid={`task-row-${task.taskId}`}
      onClick={() => onSelect(task.taskId)}
      onKeyDown={(event) => {
        // 只认行壳自身发起的键事件:行内 pin/收藏是原生 button,自带 Enter/Space 激活。
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(task.taskId);
        }
      }}
      className={`flex w-full cursor-pointer items-center gap-1 pr-2 hover:bg-text/5 ${
        task.visibility.archived ? "opacity-55" : ""
      } ${pinned ? "bg-accent/[0.06]" : isFavorite ? "bg-accent/[0.04]" : ""}`}
    >
      {isExternal(task) && (
        <Lock weight="bold" className="ml-2 shrink-0 ui-meta text-text-faint" aria-label="外部引擎只读" />
      )}
      <div className="min-w-0 flex-1">
        <DenseRow
          tag={<StatusTag status={task.canonicalStatus ?? task.coordinationStatus} />}
          title={task.title}
          reason={task.taskId}
          time={relativeTime(task.lastKnownAt)}
        />
      </div>
      {onSetPin ? (
        <button
          type="button"
          data-testid={`task-pin-toggle-${task.taskId}`}
          onClick={(event) => {
            event.stopPropagation();
            onSetPin(task, !pinned);
          }}
          title={pinned ? t("views.listView.unpinTitle") : t("views.listView.pinTitle")}
          aria-pressed={pinned}
          className={`relative inline-flex shrink-0 items-center justify-center rounded p-0.5 ui-body hover:bg-surface after:absolute after:content-[''] after:-top-[11.5px] after:-bottom-[11.5px] after:-left-[2px] after:-right-[1.75px] ${
            pinned ? "text-accent" : "text-text-faint hover:text-text-muted"
          }`}
        >
          <PushPin weight={pinned ? "fill" : "bold"} />
        </button>
      ) : (
        pinned && (
          <span
            title={t("views.listView.pinnedToday")}
            data-testid={`task-pinned-marker-${task.taskId}`}
            className="inline-flex shrink-0 items-center p-0.5 text-accent"
          >
            <PushPin weight="fill" className="ui-body" />
          </span>
        )
      )}
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onToggleFavorite(task.taskId);
        }}
        title={isFavorite ? t("views.listView.cancelFavorites") : t("views.listView.favoritesPinned")}
        className={`relative inline-flex shrink-0 items-center justify-center rounded p-0.5 ui-body hover:bg-surface after:absolute after:content-[''] after:-top-[11.5px] after:-bottom-[11.5px] after:-left-[1.75px] after:-right-[5px] ${
          isFavorite ? "text-accent" : "text-text-faint hover:text-text-muted"
        }`}
      >
        <Star weight={isFavorite ? "fill" : "bold"} />
      </button>
    </div>
  );
});

/** 终态分隔线(标准 §1.4 v2):「已完成 N · 已取消 N」一行,之后照常渲染终态行。 */
function TerminalDivider({ done, cancelled }: { done: number; cancelled: number }) {
  return (
    <div data-testid="list-terminal-divider" className="border-t border-border">
      <CompletedDivider>
        {t("views.listView.terminalDone", { count: done })}
        {cancelled > 0 ? ` · ${t("views.listView.terminalCancelled", { count: cancelled })}` : ""}
      </CompletedDivider>
    </div>
  );
}

type ListItem = { readonly kind: "row"; readonly task: TaskRow } | { readonly kind: "divider" };

export function ListView({
  tasks,
  onSelect,
  favorites,
  onToggleFavorite,
  onSetPin,
}: {
  tasks: readonly TaskRow[];
  onSelect: (id: string) => void;
  favorites?: ReadonlySet<string>;
  onToggleFavorite?: (id: string) => void;
  /** 台账 pin 写通道;缺省时行内只显示 📌 状态,不给写按钮。 */
  onSetPin?: (task: TaskRow, pinned: boolean) => void;
}) {
  const favSet = favorites ?? new Set<string>();
  // 默认序共用实现(W8):lastKnownAt 倒序打底,pin(canonical)→ 本地收藏稳定置顶;
  // 终态沉底(标准 §2.4 v2:分隔线之后照常显示,不折叠),找任务先看到仍在推进的行。
  // pinned 恒在开放区(W8 先例:折叠不许吞掉「今天在做」),即使它已是终态。
  const sorted = useMemo(
    () =>
      sortByRecentThenPinAndFavoritesFirst(tasks, favSet).sort(
        (a, b) => Number(isTerminal(a) && a.pinned !== true) - Number(isTerminal(b) && b.pinned !== true),
      ),
    [tasks, favSet],
  );
  const openRows = useMemo(() => sorted.filter((task) => !isTerminal(task) || task.pinned === true), [sorted]);
  const terminalRows = useMemo(() => sorted.filter((task) => isTerminal(task) && task.pinned !== true), [sorted]);
  const terminalDone = terminalRows.filter(
    (task) => (task.canonicalStatus ?? task.coordinationStatus) !== "cancelled",
  ).length;
  const terminalCancelled = terminalRows.length - terminalDone;

  const items: readonly ListItem[] = useMemo(
    () => [
      ...openRows.map((task): ListItem => ({ kind: "row", task })),
      ...(terminalRows.length > 0 ? ([{ kind: "divider" }] as ListItem[]) : []),
      ...terminalRows.map((task): ListItem => ({ kind: "row", task })),
    ],
    [openRows, terminalRows],
  );

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE_PX,
    overscan: ROW_OVERSCAN,
    getItemKey: (index) => {
      const item = items[index];
      return item === undefined ? String(index) : item.kind === "row" ? item.task.taskId : "terminal-divider";
    },
  });

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto" data-testid="list-scroll">
        {items.length === 0 ? (
          <p className="px-4 py-6 ui-meta text-text-muted">
            {t("views.listView.noMatchingTasks")} · {t("views.listView.broadenSearchStatusOpenArchivesView")}
          </p>
        ) : (
          <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const entry = items[item.index];
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  className="absolute inset-x-0 top-0"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  {entry !== undefined && entry.kind === "divider" ? (
                    <TerminalDivider done={terminalDone} cancelled={terminalCancelled} />
                  ) : entry !== undefined ? (
                    <TaskListRow
                      task={entry.task}
                      onSelect={onSelect}
                      isFavorite={favSet.has(entry.task.taskId)}
                      onToggleFavorite={onToggleFavorite ?? (() => undefined)}
                      onSetPin={onSetPin}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
