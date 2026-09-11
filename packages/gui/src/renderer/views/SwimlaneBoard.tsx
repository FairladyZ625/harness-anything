import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { CaretRight, Lock, PushPin, Star } from "@phosphor-icons/react";
import type { TaskRow, SnapshotStatus } from "../model/types";
import { BOARD_COLUMNS, isExternal } from "../model/types";
import { STATUS_META, CloseoutBadge, DecisionSourceBadge, FreshnessTag, freshnessBorder } from "../components/badges";
import { ColumnResizeHandle } from "../components/ColumnResizeHandle.tsx";
import {
  boardColumnPreferenceStorage,
  clearBoardColumnWidth,
  readBoardColumnWidths,
  setBoardColumnWidth,
  writeBoardColumnWidths,
  type BoardColumnWidths,
} from "../board-column-preferences.ts";
import { spawningDecisionBadge } from "../model/triadic";
import { TaskRootBadge } from "../components/TaskWipSummary.tsx";
import { sortByRecentThenPinAndFavoritesFirst } from "../model/taskFilters";

export type LaneGroupBy = "module" | "engine" | "root" | "productLine";

/** 泳道列宽默认值 = 原 GRID_COLS(180px 泳道标签 + 7×230px 状态列);可调区间各自独立。 */
const LANE_COLUMN_KEY = "lane";
const LANE_WIDTH_DEFAULT = 180;
const LANE_WIDTH_RANGE = { min: 120, max: 480 } as const;
const STATUS_WIDTH_DEFAULT = 230;
const STATUS_WIDTH_RANGE = { min: 160, max: 640 } as const;

/** 泳道行 windowing(W10):估算行高 = 单元格 min-h 62px + py-2.5 + border,实测收敛。 */
const LANE_ROW_ESTIMATE_PX = 84;
const LANE_ROW_OVERSCAN = 4;

const cellKey = (lane: string, status: SnapshotStatus) => `${lane}::${status}`;

type ActiveCell = { lane: string; status: SnapshotStatus };

/** 把 groupBy 解析成每个 task 的分组 key 字符串。 */
export const UNASSIGNED_PLT_LANE = "__unassigned_plt__";

function groupKeyOf(task: TaskRow, groupBy: LaneGroupBy): string {
  if (groupBy === "module") return task.module;
  if (groupBy === "engine") return task.engine;
  if (groupBy === "productLine") return task.productLines?.[0] ?? UNASSIGNED_PLT_LANE;
  // root:用 rootTaskId(若缺失则退回自身,显示为顶层独立 task)
  return task.rootTaskId ?? task.taskId;
}

/** 把分组 key 翻译成展示标签;root 用组内代表(rootTitle,缺失退回代表自身标题)。 */
function laneLabelOf(key: string, groupBy: LaneGroupBy, representative: TaskRow): string {
  if (groupBy === "root") return representative.rootTitle ?? representative.title ?? key;
  if (groupBy === "productLine" && key === UNASSIGNED_PLT_LANE) return "未投影 PLT";
  return key;
}

/** 单遍分组模型(W9):一次遍历产出 lane→status→rows、列头计数与泳道标签,
 * 替代「每次渲染 7×O(n) 列头 filter + lanes×7 单元格 filter + 每泳道一次
 * O(n) 标签 find」。lane 行序与单元格内序保持 W8 语义:组内 lastKnownAt 倒序。 */
interface SwimlaneModel {
  readonly lanes: string[];
  readonly labels: ReadonlyMap<string, string>;
  readonly cells: ReadonlyMap<string, ReadonlyMap<SnapshotStatus, readonly TaskRow[]>>;
  readonly laneSizes: ReadonlyMap<string, number>;
  readonly totals: ReadonlyMap<SnapshotStatus, number>;
}

const EMPTY_CELL: readonly TaskRow[] = [];

function cellOf(model: SwimlaneModel, lane: string, status: SnapshotStatus): readonly TaskRow[] {
  return model.cells.get(lane)?.get(status) ?? EMPTY_CELL;
}

function buildSwimlaneModel(tasks: ReadonlyArray<TaskRow>, groupBy: LaneGroupBy): SwimlaneModel {
  const groups = new Map<string, TaskRow[]>();
  const labels = new Map<string, string>();
  const totals = new Map<SnapshotStatus, number>(BOARD_COLUMNS.map((status) => [status, 0]));
  for (const task of tasks) {
    const key = groupKeyOf(task, groupBy);
    let group = groups.get(key);
    if (group === undefined) {
      group = [];
      groups.set(key, group);
      // 代表 = 组内第一行(输入序),与旧实现的 tasks.find 首个命中同源。
      labels.set(key, laneLabelOf(key, groupBy, task));
    }
    group.push(task);
    totals.set(task.coordinationStatus, (totals.get(task.coordinationStatus) ?? 0) + 1);
  }
  const cells = new Map<string, ReadonlyMap<SnapshotStatus, readonly TaskRow[]>>();
  const laneSizes = new Map<string, number>();
  const lanes = [...groups.entries()]
    .map(([lane, group]) => {
      // 组内按 lastKnownAt 倒序(W8):组首即组内最新活动,泳道行序与单元格序都取它。
      group.sort((a, b) => b.lastKnownAt.localeCompare(a.lastKnownAt));
      const byStatus = new Map<SnapshotStatus, TaskRow[]>(BOARD_COLUMNS.map((status) => [status, []]));
      for (const task of group) byStatus.get(task.coordinationStatus)!.push(task);
      cells.set(lane, byStatus);
      laneSizes.set(lane, group.length);
      return [lane, group[0]?.lastKnownAt ?? ""] as const;
    })
    .sort(([, a], [, b]) => b.localeCompare(a))
    .map(([lane]) => lane);
  return { lanes, labels, cells, laneSizes, totals };
}

/** 泳道下钻卡 memo(W9):比较键同列模式 Card——行引用 + 稳定回调,不写自定义比较器;
 * 决策来源徽章按行自取(行内 placement 派生),不接任何全局关系数组。 */
const LaneCard = memo(function LaneCard({
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
  const external = isExternal(task);
  const archived = task.visibility.archived;
  const spawningDecision = spawningDecisionBadge(task);
  return (
    <div
      onClick={() => onSelect(task.taskId)}
      title={external ? "外部引擎管理 · 只读" : undefined}
      className={[
        "flex min-h-[150px] cursor-pointer flex-col rounded-lg bg-surface-raised px-3.5 py-3 cv-auto-10r",
        freshnessBorder(task.freshness),
        archived ? "opacity-50" : "",
        isFavorite ? "ring-1 ring-accent/40" : "",
        "hover:border-border-strong",
      ].join(" ")}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {external && <Lock weight="bold" className="shrink-0 ui-body text-text-faint" />}
        <TaskRootBadge task={task} />
        {onSetPin ? (
          <button
            type="button"
            data-testid={`swimlane-pin-toggle-${task.taskId}`}
            onClick={(event) => {
              event.stopPropagation();
              onSetPin(task, task.pinned !== true);
            }}
            title={task.pinned === true ? "解除 pin" : "Pin(今天当前在做)"}
            aria-pressed={task.pinned === true}
            className={`inline-flex items-center justify-center rounded p-0.5 ui-body hover:bg-surface ${
              task.pinned === true ? "text-accent" : "text-text-faint hover:text-text-muted"
            }`}
          >
            <PushPin weight={task.pinned === true ? "fill" : "bold"} />
          </button>
        ) : task.pinned === true ? (
          <PushPin weight="fill" className="shrink-0 ui-body text-accent" />
        ) : null}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onToggleFavorite(task.taskId);
          }}
          title={isFavorite ? "取消收藏" : "收藏(置顶)"}
          className={`ml-auto inline-flex items-center justify-center rounded p-0.5 ui-body hover:bg-surface ${
            isFavorite ? "text-accent" : "text-text-faint hover:text-text-muted"
          }`}
        >
          <Star weight={isFavorite ? "fill" : "bold"} />
        </button>
      </div>
      <p className="mt-2 line-clamp-3 ui-prose leading-snug text-text">{task.title}</p>
      <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-3">
        {task.coordinationStatus === "blocked" && task.canonicalStatus && (
          <span className="font-mono ui-micro text-status-blocked">canonical {task.canonicalStatus}</span>
        )}
        {task.blocking === "unknown" && <span className="ui-micro text-stale">阻塞关系未能确定</span>}
        {spawningDecision && <DecisionSourceBadge decisionId={spawningDecision} compact />}
        <CloseoutBadge value={task.closeoutReadiness} />
        <FreshnessTag freshness={task.freshness} lastKnownAt={task.lastKnownAt} />
      </div>
    </div>
  );
});

/**
 * 单条泳道行(windowing 后的挂载单元):结构不变——lane 标签 + 7 个状态格;
 * 外层由 windowing 定位(absolute + translateY),data-index 供 virtualizer
 * 的 measureElement 反查行号,行高实测收敛(标签换行时行会高于估算)。
 * 列模板跟随表头的 gridTemplateColumns(W11):表头/行同一份宽度偏好。
 */
function LaneRow({
  lane,
  index,
  offset,
  gridTemplate,
  measureRef,
  model,
  groupBy,
  activeCell,
  highlighted,
  onPickCell,
}: {
  lane: string;
  index: number;
  offset: number;
  gridTemplate: string;
  measureRef: (element: Element | null) => void;
  model: SwimlaneModel;
  groupBy: LaneGroupBy;
  activeCell: ActiveCell | null;
  highlighted: string | null;
  onPickCell: (cell: ActiveCell) => void;
}) {
  return (
    <div
      data-index={index}
      ref={measureRef}
      data-testid="swimlane-row"
      className="absolute inset-x-0 top-0 grid gap-2 border-b border-border py-2.5"
      style={{ gridTemplateColumns: gridTemplate, transform: `translateY(${offset}px)` }}
    >
      <div className="flex items-baseline gap-2 self-start px-1.5 pt-1.5">
        <span className="font-mono ui-prose font-semibold text-text" title={groupBy === "root" ? lane : undefined}>
          {model.labels.get(lane) ?? lane}
        </span>
        <span className="font-mono ui-body text-text-faint">{model.laneSizes.get(lane) ?? 0}</span>
      </div>
      {BOARD_COLUMNS.map((status) => {
        const key = cellKey(lane, status);
        const selected = activeCell?.lane === lane && activeCell.status === status;
        return (
          <LaneCell
            key={status}
            status={status}
            cellTasks={cellOf(model, lane, status)}
            selected={selected}
            highlighted={highlighted === key}
            onPick={() => onPickCell({ lane, status })}
          />
        );
      })}
    </div>
  );
}

function LaneCell({
  status,
  cellTasks,
  selected,
  highlighted,
  onPick,
}: {
  status: SnapshotStatus;
  cellTasks: readonly TaskRow[];
  selected: boolean;
  highlighted: boolean;
  onPick: () => void;
}) {
  const meta = STATUS_META[status];
  if (cellTasks.length === 0) {
    return (
      <div className="min-h-[62px] rounded-lg border border-border/60 bg-surface/30 px-3 py-2 text-center ui-body text-text-faint">
        -
      </div>
    );
  }
  const preview = cellTasks[0];
  return (
    <button
      onClick={onPick}
      title="在下方查看下钻任务"
      className={`min-h-[62px] w-full rounded-lg border px-3 py-2 text-left transition ${
        selected
          ? "border-accent bg-surface-raised"
          : "border-border bg-surface hover:border-border-strong hover:bg-surface-raised"
      } ${highlighted ? "outline outline-1 outline-accent" : ""}`}
      style={{
        background: selected ? `color-mix(in oklch, ${meta.color} 14%, var(--color-surface-raised))` : undefined,
      }}
    >
      <span className="flex items-center gap-2">
        <span
          className="inline-flex min-w-8 justify-center rounded-md px-2 py-0.5 font-mono ui-title font-semibold"
          style={{
            color: meta.color,
            background: `color-mix(in oklch, ${meta.color} 14%, transparent)`,
          }}
        >
          {cellTasks.length}
        </span>
        <span className="min-w-0 ui-body font-semibold text-text">{meta.label}</span>
        {selected && <CaretRight weight="bold" className="ml-auto shrink-0 ui-body text-text-faint" />}
      </span>
      <span className="mt-1.5 block truncate ui-meta text-text-muted">{preview.title}</span>
    </button>
  );
}

function DrilldownPanel({
  active,
  tasks,
  groupBy,
  laneLabel,
  onSelect,
  favorites,
  onToggleFavorite,
  onSetPin,
}: {
  active: ActiveCell | null;
  tasks: readonly TaskRow[];
  groupBy: LaneGroupBy;
  laneLabel: string;
  onSelect: (id: string) => void;
  favorites: ReadonlySet<string>;
  onToggleFavorite: (id: string) => void;
  onSetPin?: (task: TaskRow, pinned: boolean) => void;
}) {
  if (!active) {
    return (
      <section className="flex min-h-0 flex-1 flex-col bg-bg px-4 py-3">
        <div className="h-full rounded-lg border border-dashed border-border px-4 py-5 ui-prose text-text-faint">
          选择上方泳道单元格后，在这里查看该组任务。
        </div>
      </section>
    );
  }

  const meta = STATUS_META[active.status];
  // 下钻默认序(W8):lastKnownAt 倒序打底,pin → 收藏稳定置顶,与列模式同构。
  const sorted = sortByRecentThenPinAndFavoritesFirst(tasks, favorites);

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-bg px-4 py-3">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="font-mono ui-meta uppercase tracking-wide text-text-faint">下钻结果</span>
        <span className="font-mono ui-prose font-semibold text-text">
          {groupBy}: {laneLabel}
        </span>
        <span className="inline-flex items-center gap-1.5 ui-prose font-semibold">
          <span style={{ color: meta.color }} className="text-base">
            {meta.icon}
          </span>
          {meta.label}
        </span>
        <span className="font-mono ui-body text-text-faint">{tasks.length} tasks</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto pr-1">
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2 2xl:grid-cols-3">
          {sorted.map((t) => (
            <LaneCard
              key={t.taskId}
              task={t}
              onSelect={onSelect}
              isFavorite={favorites.has(t.taskId)}
              onToggleFavorite={onToggleFavorite}
              onSetPin={onSetPin}
            />
          ))}
        </div>
      </div>

      {tasks.length === 0 && (
        <div className="rounded-lg border border-dashed border-border px-3 py-4 ui-prose text-text-faint">
          该单元格暂无任务
        </div>
      )}
    </section>
  );
}

export function SwimlaneBoard({
  tasks,
  groupBy,
  onSelect,
  drill,
  favorites,
  onToggleFavorite,
  onSetPin,
}: {
  tasks: readonly TaskRow[];
  groupBy: LaneGroupBy;
  onSelect: (id: string) => void;
  drill: { lane: string; status: SnapshotStatus; groupBy: LaneGroupBy } | null;
  favorites: ReadonlySet<string>;
  onToggleFavorite: (id: string) => void;
  onSetPin?: (task: TaskRow, pinned: boolean) => void;
}) {
  const drillMatches = Boolean(drill && drill.groupBy === groupBy);
  const drillLane = drill?.lane;
  const drillStatus = drill?.status;
  const [activeCell, setActiveCell] = useState<ActiveCell | null>(() =>
    drillMatches && drillLane && drillStatus ? { lane: drillLane, status: drillStatus } : null,
  );

  useEffect(() => {
    if (drillMatches && drillLane && drillStatus) {
      setActiveCell({ lane: drillLane, status: drillStatus });
    }
  }, [drillMatches, drillLane, drillStatus]);

  const model = useMemo(() => buildSwimlaneModel(tasks, groupBy), [groupBy, tasks]);
  const lanes = model.lanes;

  // 泳道行 windowing(W10):基线 canonical 928 行全挂载、切到首行 4.8s;只挂
  // 视口 ± overscan 后 DOM 行数与泳道总量解耦。行高不定(lane 标签换行),
  // estimateSize 起步、measureElement 实测收敛;sticky 表头在滚动容器内、
  // 位于行容器上方,scrollMargin = 表头实测高度让可视窗口换算进行坐标系。
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const [headerHeight, setHeaderHeight] = useState(0);
  useEffect(() => {
    const element = headerRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setHeaderHeight(element.offsetHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const laneVirtualizer = useVirtualizer({
    count: lanes.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LANE_ROW_ESTIMATE_PX,
    overscan: LANE_ROW_OVERSCAN,
    getItemKey: (index) => lanes[index],
    scrollMargin: headerHeight,
  });
  // 泳道列宽偏好(W11):泳道标签列 + 7 个状态列各一个数字,默认 180/230 等宽;
  // 表头是唯一手柄面(sticky,滚动时仍可达),行模板跟着表头走。
  const [widths, setWidths] = useState<BoardColumnWidths>(() => readBoardColumnWidths(boardColumnPreferenceStorage()));
  const resizeColumn = useCallback(
    (key: string, px: number) => {
      const next = setBoardColumnWidth(widths, "swimlane", key, px);
      setWidths(next);
      writeBoardColumnWidths(boardColumnPreferenceStorage(), next);
    },
    [widths],
  );
  const resetColumn = useCallback(
    (key: string) => {
      const next = clearBoardColumnWidth(widths, "swimlane", key);
      setWidths(next);
      writeBoardColumnWidths(boardColumnPreferenceStorage(), next);
    },
    [widths],
  );
  const laneWidth = widths.swimlane[LANE_COLUMN_KEY] ?? LANE_WIDTH_DEFAULT;
  const gridStyle = {
    gridTemplateColumns: [laneWidth, ...BOARD_COLUMNS.map((status) => widths.swimlane[status] ?? STATUS_WIDTH_DEFAULT)]
      .map((px) => `${Math.round(px)}px`)
      .join(" "),
  };

  useEffect(() => {
    if (activeCell && !lanes.includes(activeCell.lane)) setActiveCell(null);
  }, [activeCell, lanes]);

  const highlight = drillMatches && drillLane && drillStatus ? cellKey(drillLane, drillStatus) : null;

  const activeTasks = useMemo(
    () => (activeCell ? cellOf(model, activeCell.lane, activeCell.status) : EMPTY_CELL),
    [activeCell, model],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} data-testid="swimlane-scroll" className="max-h-[48vh] overflow-auto border-b border-border">
        <div className="min-w-max px-4 pb-4">
          <div
            ref={headerRef}
            className="sticky top-0 z-10 grid gap-2 border-b border-border bg-bg py-2"
            style={gridStyle}
          >
            <div className="relative self-center px-1.5 font-mono ui-meta uppercase tracking-wide text-text-faint">
              {groupBy}
              <ColumnResizeHandle
                label="调整泳道标签列宽"
                width={laneWidth}
                min={LANE_WIDTH_RANGE.min}
                max={LANE_WIDTH_RANGE.max}
                onChange={(px) => resizeColumn(LANE_COLUMN_KEY, px)}
                onReset={() => resetColumn(LANE_COLUMN_KEY)}
                testId="swimlane-lane-resize"
                className="inset-y-0 -right-1"
              />
            </div>
            {BOARD_COLUMNS.map((status) => {
              const meta = STATUS_META[status];
              return (
                <div key={status} className="relative flex items-center gap-1.5 px-1.5">
                  <ColumnResizeHandle
                    label={`调整「${meta.label}」列宽`}
                    width={widths.swimlane[status] ?? STATUS_WIDTH_DEFAULT}
                    min={STATUS_WIDTH_RANGE.min}
                    max={STATUS_WIDTH_RANGE.max}
                    onChange={(px) => resizeColumn(status, px)}
                    onReset={() => resetColumn(status)}
                    testId={`swimlane-column-resize-${status}`}
                    className="inset-y-0 -right-1"
                  />
                  <span style={{ color: meta.color }} className="text-base">
                    {meta.icon}
                  </span>
                  <span className="ui-body font-semibold">{meta.label}</span>
                  <span className="font-mono ui-body text-text-faint" data-testid={`swimlane-status-${status}-count`}>
                    {model.totals.get(status) ?? 0}
                  </span>
                </div>
              );
            })}
          </div>
          {lanes.length > 0 && (
            <div
              className="relative"
              style={{ height: laneVirtualizer.getTotalSize() }}
              data-testid="swimlane-row-window"
            >
              {laneVirtualizer.getVirtualItems().map((row) => (
                <LaneRow
                  key={row.key}
                  lane={lanes[row.index]}
                  index={row.index}
                  offset={row.start}
                  gridTemplate={gridStyle.gridTemplateColumns}
                  measureRef={laneVirtualizer.measureElement}
                  model={model}
                  groupBy={groupBy}
                  activeCell={activeCell}
                  highlighted={highlight}
                  onPickCell={setActiveCell}
                />
              ))}
            </div>
          )}
          {lanes.length === 0 && (
            <div className="rounded-lg border border-dashed border-border px-4 py-8 ui-prose text-text-faint">
              当前筛选下没有可展示的泳道任务。
            </div>
          )}
        </div>
      </div>
      <DrilldownPanel
        active={activeCell}
        tasks={activeTasks}
        groupBy={groupBy}
        laneLabel={activeCell ? (model.labels.get(activeCell.lane) ?? activeCell.lane) : ""}
        onSelect={onSelect}
        favorites={favorites}
        onToggleFavorite={onToggleFavorite}
        onSetPin={onSetPin}
      />
    </div>
  );
}
