import { memo, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Lock, PushPin, Star } from "@phosphor-icons/react";
import type { TaskRow } from "../model/types";
import { isExternal, isTerminal } from "../model/types";
import { StatusTag } from "../components/primitives/StatusTag";
import { DenseRow } from "../components/primitives/DenseRow";
import { sortByRecentThenPinAndFavoritesFirst } from "../model/taskFilters";
import { t } from "../i18n/index.tsx";
import { relativeTime } from "../sessions-model";

/** 列表行 windowing:行高 25px + 分隔线;实测由 measureElement 收敛。 */
const ROW_ESTIMATE_PX = 28;
const ROW_OVERSCAN = 12;

/**
 * 任务列表(标准 §2.4 列表页):回答「我要找某个任务」。搜索与筛选由看板的
 * TaskFilterBar 提供(本视图只作为看板的列表布局渲染);行用 DenseRow、状态用
 * 有底色的 StatusTag,默认序与看板卡片同一实现(W8:lastKnownAt 倒序 + pin →
 * 收藏置顶);终态(完成/取消)一律沉底并折叠成一行「已完成 N 个 · 展开」,
 * 展开后跟随其后。整表 windowing:DOM 行数与总量解耦,无分页。
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
      className={`group flex w-full cursor-pointer items-center gap-1 pr-2 hover:bg-text/5 ${
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
          className={`inline-flex shrink-0 items-center justify-center rounded p-0.5 ui-body hover:bg-surface ${
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
        className={`inline-flex shrink-0 items-center justify-center rounded p-0.5 ui-body hover:bg-surface ${
          isFavorite ? "text-accent" : "text-text-faint opacity-0 hover:text-text-muted group-hover:opacity-100"
        }`}
      >
        <Star weight={isFavorite ? "fill" : "bold"} />
      </button>
    </div>
  );
});

/** 终态折叠行(标准 §2.4):「已完成 N 个 · 展开」一行;取消单列计数,不做第二行。 */
function TerminalCollapse({
  done,
  cancelled,
  expanded,
  onToggle,
}: {
  done: number;
  cancelled: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      data-testid="list-terminal-toggle"
      aria-expanded={expanded}
      onClick={onToggle}
      className="flex w-full items-center gap-1.5 border-t border-border px-3 py-1.5 text-left ui-meta text-text-muted hover:text-text"
    >
      <span aria-hidden>{expanded ? "▾" : "▸"}</span>
      {t("views.listView.terminalDone", { count: done })}
      {cancelled > 0 ? ` · ${t("views.listView.terminalCancelled", { count: cancelled })}` : ""}
      {" · "}
      {expanded ? t("views.listView.terminalCollapseAction") : t("views.listView.terminalExpandAction")}
    </button>
  );
}

type ListItem = { readonly kind: "row"; readonly task: TaskRow } | { readonly kind: "collapse" };

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
  const [expanded, setExpanded] = useState(false);
  const favSet = favorites ?? new Set<string>();
  // 默认序共用实现(W8):lastKnownAt 倒序打底,pin(canonical)→ 本地收藏稳定置顶;
  // 终态沉底(标准 §2.4),找任务先看到仍在推进的行。pinned 恒在展开区(W8 先例:
  // 折叠不许吞掉「今天在做」),即使它已是终态。
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
      ...(terminalRows.length > 0 ? ([{ kind: "collapse" }] as ListItem[]) : []),
      ...(expanded ? terminalRows.map((task): ListItem => ({ kind: "row", task })) : []),
    ],
    [openRows, terminalRows, expanded],
  );

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE_PX,
    overscan: ROW_OVERSCAN,
    getItemKey: (index) => {
      const item = items[index];
      return item === undefined ? String(index) : item.kind === "row" ? item.task.taskId : "terminal-collapse";
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
                  {entry !== undefined && entry.kind === "collapse" ? (
                    <TerminalCollapse
                      done={terminalDone}
                      cancelled={terminalCancelled}
                      expanded={expanded}
                      onToggle={() => setExpanded((current) => !current)}
                    />
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
