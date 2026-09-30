import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { CaretRight, Lock, PushPin, Star } from "@phosphor-icons/react";
import type { TaskRow, SnapshotStatus } from "../model/types";
import { boardColumnOf, isExternal, isTerminal } from "../model/types";
import { STATUS_META, freshnessBorder } from "../components/badges";
import { ColumnResizeHandle } from "../components/ColumnResizeHandle.tsx";
import {
  boardColumnPreferenceStorage,
  clearBoardColumnWidth,
  readBoardColumnWidths,
  setBoardColumnWidth,
  writeBoardColumnWidths,
  type BoardColumnWidths,
} from "../board-column-preferences.ts";
import { Drawer } from "../components/primitives/Drawer.tsx";
import { SegBar } from "../components/primitives/SegBar.tsx";
import { StatusTag, STATUS_TONE } from "../components/primitives/StatusTag.tsx";
import { TitleText } from "../components/primitives/TitleText.tsx";
import { relativeTime } from "../sessions-model.ts";
import { sortByRecentThenPinAndFavoritesFirst } from "../model/taskFilters";

/** 泳道分组维度;"root" = 按工作分组(一个根 task 加它的 parentTaskId 子树)。 */
export type LaneGroupBy = "engine" | "root" | "productLine";

/** 泳道列宽默认值 = 原 GRID_COLS(180px 泳道标签 + N×230px 状态列);可调区间各自独立。 */
const LANE_COLUMN_KEY = "lane";
const LANE_WIDTH_DEFAULT = 180;
const LANE_WIDTH_RANGE = { min: 120, max: 480 } as const;
const STATUS_WIDTH_DEFAULT = 230;
const STATUS_WIDTH_RANGE = { min: 160, max: 640 } as const;
/** 0 计数状态列折叠后的轨道宽(标准 §2.4 空列收窄成一条竖线),与列模式竖线同宽。 */
const EMPTY_STATUS_WIDTH_PX = 3;

/** 泳道行 windowing(W10):估算行高 = 单元格 min-h 62px + py-2.5 + border,实测收敛。 */
const LANE_ROW_ESTIMATE_PX = 84;
const LANE_ROW_OVERSCAN = 4;

const cellKey = (lane: string, status: SnapshotStatus) => `${lane}::${status}`;

type ActiveCell = { lane: string; status: SnapshotStatus };

/** 把 groupBy 解析成每个 task 的分组 key 字符串。 */
export const UNASSIGNED_PLT_LANE = "__unassigned_plt__";

function groupKeyOf(task: TaskRow, groupBy: LaneGroupBy): string {
  if (groupBy === "engine") return task.engine;
  if (groupBy === "productLine") return task.productLines?.[0] ?? UNASSIGNED_PLT_LANE;
  // root(工作):用所属工作 workId(daemon 工作索引);不属于任何工作的 task 自成一道
  return task.workId ?? task.taskId;
}

/** 把分组 key 翻译成展示标签;root 用组内代表(workTitle,缺失退回代表自身标题)。 */
function laneLabelOf(key: string, groupBy: LaneGroupBy, representative: TaskRow): string {
  if (groupBy === "root") return representative.workTitle ?? representative.title ?? key;
  if (groupBy === "productLine" && key === UNASSIGNED_PLT_LANE) return "未投影 PLT";
  return key;
}

/** 单遍分组模型(W9):一次遍历产出 lane→status→rows、列头计数与泳道标签,
 * 替代「每次渲染 N×O(n) 列头 filter + lanes×N 单元格 filter + 每泳道一次
 * O(n) 标签 find」。分组键是看板列桶 boardColumnOf——归档行进 archived 列
 * (task_8928cf1e)。lane 行序与单元格内序保持 W8 语义:组内 lastKnownAt 倒序。 */
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

function buildSwimlaneModel(
  tasks: ReadonlyArray<TaskRow>,
  groupBy: LaneGroupBy,
  columns: readonly SnapshotStatus[],
): SwimlaneModel {
  const groups = new Map<string, TaskRow[]>();
  const labels = new Map<string, string>();
  const totals = new Map<SnapshotStatus, number>(columns.map((status) => [status, 0]));
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
    const bucket = boardColumnOf(task);
    totals.set(bucket, (totals.get(bucket) ?? 0) + 1);
  }
  const cells = new Map<string, ReadonlyMap<SnapshotStatus, readonly TaskRow[]>>();
  const laneSizes = new Map<string, number>();
  const lanes = [...groups.entries()]
    .map(([lane, group]) => {
      // 组内按 lastKnownAt 倒序(W8):组首即组内最新活动,泳道行序与单元格序都取它。
      group.sort((a, b) => b.lastKnownAt.localeCompare(a.lastKnownAt));
      const byStatus = new Map<SnapshotStatus, TaskRow[]>(columns.map((status) => [status, []]));
      for (const task of group) byStatus.get(boardColumnOf(task))!.push(task);
      cells.set(lane, byStatus);
      laneSizes.set(lane, group.length);
      return [lane, group[0]?.lastKnownAt ?? ""] as const;
    })
    .sort(([, a], [, b]) => b.localeCompare(a))
    .map(([lane]) => lane);
  return { lanes, labels, cells, laneSizes, totals };
}

/**
 * 泳道下钻卡 memo(W9):比较键同列模式 Card——行引用 + 稳定回调,不写自定义比较器。
 * 卡片面同列模式(标准 §2.4):状态标签、标题(经 TitleText)、一行原因与时间。
 */
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
  return (
    <div
      onClick={() => onSelect(task.taskId)}
      title={external ? "外部引擎管理 · 只读" : undefined}
      className={[
        "cursor-pointer rounded-md bg-surface-raised px-3 py-2.5",
        freshnessBorder(task.freshness),
        archived ? "opacity-50" : "",
        isFavorite ? "ring-1 ring-accent/40" : "",
        "hover:border-border-strong",
      ].join(" ")}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {external && <Lock weight="bold" className="shrink-0 ui-meta text-text-faint" aria-label="外部引擎只读" />}
        <StatusTag status={task.canonicalStatus ?? task.coordinationStatus} />
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
          <span title="📌 今天当前在做" className="inline-flex shrink-0 items-center text-accent">
            <PushPin weight="fill" className="ui-body" />
          </span>
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
      <p className="mt-1.5 line-clamp-2 ui-prose leading-snug text-text">
        <TitleText title={task.title} />
      </p>
      <div className="mt-1.5 flex items-baseline justify-between gap-1.5">
        <span className="min-w-0 truncate font-mono ui-micro text-text-faint">{task.taskId}</span>
        <span className="shrink-0 font-mono ui-micro text-text-faint">{relativeTime(task.lastKnownAt)}</span>
      </div>
    </div>
  );
});

/**
 * 单条泳道行(windowing 后的挂载单元):结构不变——lane 标签 + 状态格(列集
 * 跟随筛选,task_8928cf1e 起含 archived 桶);外层由 windowing 定位(absolute +
 * translateY),data-index 供 virtualizer 的 measureElement 反查行号,行高实测
 * 收敛(标签最多 2 行,行高仍以实测为准)。列模板跟随表头的 gridTemplateColumns
 * (W11):表头/行同一份宽度偏好。
 */
function LaneRow({
  lane,
  index,
  offset,
  gridTemplate,
  columns,
  measureRef,
  model,
  activeCell,
  highlighted,
  onPickCell,
}: {
  lane: string;
  index: number;
  offset: number;
  gridTemplate: string;
  columns: readonly SnapshotStatus[];
  measureRef: (element: Element | null) => void;
  model: SwimlaneModel;
  activeCell: ActiveCell | null;
  highlighted: string | null;
  onPickCell: (cell: ActiveCell) => void;
}) {
  const label = model.labels.get(lane) ?? lane;
  return (
    <div
      data-index={index}
      ref={measureRef}
      data-testid="swimlane-row"
      className="absolute inset-x-0 top-0 grid items-stretch gap-2 border-b border-border py-2.5"
      style={{ gridTemplateColumns: gridTemplate, transform: `translateY(${offset}px)` }}
    >
      {/* 泳道标签走 TitleText(标准 §2.3):正文sans字体、最多 2 行 clamp、
          完整标签放 title 悬停,计数右对齐——不再等宽字体整段折断。 */}
      <div className="flex items-start gap-2 self-start px-1.5 pt-1.5">
        <p className="min-w-0 flex-1 line-clamp-2 ui-body leading-snug text-text" title={label}>
          <TitleText title={label} />
        </p>
        <span className="shrink-0 font-mono ui-body text-text-faint">{model.laneSizes.get(lane) ?? 0}</span>
      </div>
      {columns.map((status) => {
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
  // 空格子不渲染(标准 §1.5 空了就消失):只留占位高度维持泳道行节奏。
  if (cellTasks.length === 0) {
    return <div className="min-h-[62px]" />;
  }
  const preview = cellTasks[0];
  return (
    <button
      onClick={onPick}
      title="点开右侧抽屉查看该组任务"
      className={`min-h-[62px] w-full rounded-md border px-3 py-2 text-left transition ${
        selected
          ? "border-accent bg-surface-raised"
          : "border-border/60 bg-surface/30 hover:border-border-strong hover:bg-surface-raised"
      } ${highlighted ? "outline outline-1 outline-accent" : ""}`}
    >
      <span className="flex items-center gap-2">
        <StatusTag tone={STATUS_TONE[status]} label={cellTasks.length} />
        {selected && <CaretRight weight="bold" className="ml-auto shrink-0 ui-body text-text-faint" />}
      </span>
      <span className="mt-1.5 block truncate ui-meta text-text-muted">{preview.title}</span>
    </button>
  );
}

/**
 * 泳道下钻抽屉(标准 §2.4 点单元格开 Drawer):点单元格在右侧抽屉里列出该组
 * 任务,未选中时抽屉不渲染任何占位(空了就消失)。抽屉内序与列表布局同构:
 * lastKnownAt 倒序打底,pin → 收藏稳定置顶(W8),终态沉底(§2.4)。
 */
function DrilldownDrawer({
  active,
  tasks,
  laneLabel,
  onSelect,
  favorites,
  onToggleFavorite,
  onSetPin,
  onClose,
}: {
  active: ActiveCell;
  tasks: readonly TaskRow[];
  laneLabel: string;
  onSelect: (id: string) => void;
  favorites: ReadonlySet<string>;
  onToggleFavorite: (id: string) => void;
  onSetPin?: (task: TaskRow, pinned: boolean) => void;
  onClose: () => void;
}) {
  const sorted = sortByRecentThenPinAndFavoritesFirst(tasks, favorites).sort(
    (a, b) => Number(isTerminal(a)) - Number(isTerminal(b)),
  );
  return (
    <Drawer open onClose={onClose} ariaLabel={`${laneLabel} · ${STATUS_META[active.status].label}`}>
      <div className="flex flex-col gap-3" data-testid="swimlane-drilldown">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate ui-prose font-semibold text-text" title={laneLabel}>
            {laneLabel}
          </span>
          <StatusTag status={active.status} />
          <span className="font-mono ui-body text-text-faint">{tasks.length}</span>
        </div>
        {sorted.map((task) => (
          <LaneCard
            key={task.taskId}
            task={task}
            onSelect={onSelect}
            isFavorite={favorites.has(task.taskId)}
            onToggleFavorite={onToggleFavorite}
            onSetPin={onSetPin}
          />
        ))}
      </div>
    </Drawer>
  );
}

export function SwimlaneBoard({
  tasks,
  columns,
  groupBy,
  onSelect,
  drill,
  favorites,
  onToggleFavorite,
  onSetPin,
}: {
  tasks: readonly TaskRow[];
  /** 可见状态列(= 看板筛选选中集,空选时由上层传全量);未选中的列连表头带格都不渲染。 */
  columns: readonly SnapshotStatus[];
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

  const model = useMemo(() => buildSwimlaneModel(tasks, groupBy, columns), [groupBy, tasks, columns]);
  const lanes = model.lanes;

  // 泳道行 windowing(W10):基线 canonical 928 行全挂载、切到首行 4.8s;只挂
  // 视口 ± overscan 后 DOM 行数与泳道总量解耦。行高不定(lane 标签换行),
  // estimateSize 起步、measureElement 实测收敛;sticky 表头在滚动容器内、
  // 位于行容器上方,scrollMargin = 表头实测高度让可视窗口换算进行坐标系。
  // 行容器在文档流里位于表头之后,而 virtual item 的 start 含 scrollMargin,
  // 渲染偏移要减回去——否则第一条泳道被推下整整一个表头高(空块,基线
  // §1.5 反例),这是官方 sticky-header 模式的固定拼法。
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
  // 泳道列宽偏好(W11):泳道标签列 + 各状态列一个数字,默认 180/230 等宽;
  // 表头是唯一手柄面(sticky,滚动时仍可达),行模板跟着表头走;0 计数列
  // 折叠成 3px 轨道后不放手柄(竖线没有可调的面)。
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
  // 0 计数状态列折叠成 3px 轨道(标准 §2.4):表头渲染细竖线,行内格子本就全空。
  const statusWidth = (status: SnapshotStatus): number => {
    if ((model.totals.get(status) ?? 0) === 0) return EMPTY_STATUS_WIDTH_PX;
    return widths.swimlane[status] ?? STATUS_WIDTH_DEFAULT;
  };
  const gridStyle = {
    gridTemplateColumns: [laneWidth, ...columns.map((status) => statusWidth(status))]
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
      <div ref={scrollRef} data-testid="swimlane-scroll" className="min-h-0 flex-1 overflow-auto">
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
            {columns.map((status) => {
              const meta = STATUS_META[status];
              const total = model.totals.get(status) ?? 0;
              // 0 计数状态列折叠成细竖线(标准 §2.4):列名与计数进 tooltip,
              // 不渲染标题行/SegBar/宽手柄,行内格子在 3px 轨道里本就为空。
              if (total === 0) {
                return (
                  <div
                    key={status}
                    data-testid={`swimlane-column-${status}`}
                    title={`${meta.label} · 0`}
                    className="w-[3px] shrink-0 self-stretch overflow-hidden rounded-full transition-colors"
                    style={{ background: `color-mix(in oklch, ${meta.color} 45%, transparent)` }}
                  />
                );
              }
              return (
                <div key={status} className="relative flex flex-col gap-1 px-1.5 pb-0.5">
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
                  <div className="flex items-baseline gap-1.5">
                    <span className="ui-body font-semibold">{meta.label}</span>
                    <span className="font-mono ui-body text-text-faint" data-testid={`swimlane-status-${status}-count`}>
                      {total}
                    </span>
                  </div>
                  <SegBar counts={{ [status]: total }} />
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
                  offset={row.start - laneVirtualizer.options.scrollMargin}
                  gridTemplate={gridStyle.gridTemplateColumns}
                  columns={columns}
                  measureRef={laneVirtualizer.measureElement}
                  model={model}
                  activeCell={activeCell}
                  highlighted={highlight}
                  onPickCell={setActiveCell}
                />
              ))}
            </div>
          )}
          {lanes.length === 0 && (
            <p className="px-1.5 py-4 ui-meta text-text-faint">当前筛选下没有可展示的泳道任务。</p>
          )}
        </div>
      </div>
      {activeCell !== null && (
        <DrilldownDrawer
          active={activeCell}
          tasks={activeTasks}
          laneLabel={model.labels.get(activeCell.lane) ?? activeCell.lane}
          onSelect={onSelect}
          favorites={favorites}
          onToggleFavorite={onToggleFavorite}
          onSetPin={onSetPin}
          onClose={() => setActiveCell(null)}
        />
      )}
    </div>
  );
}
