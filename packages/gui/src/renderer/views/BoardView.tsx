import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  DragOverlay,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { Lock, PushPin, Star } from "@phosphor-icons/react";
import type { TaskRow, SnapshotStatus } from "../model/types";
import { BOARD_COLUMNS, boardColumnOf, isExternal, taskCan } from "../model/types";
import { STATUS_META, freshnessBorder } from "../components/badges";
import { ColumnResizeHandle } from "../components/ColumnResizeHandle.tsx";
import {
  boardColumnPreferenceStorage,
  clearBoardColumnWidth,
  readBoardColumnWidths,
  setBoardColumnWidth,
  writeBoardColumnWidths,
} from "../board-column-preferences.ts";
import { SwimlaneBoard, type LaneGroupBy } from "./SwimlaneBoard";
import { TaskFilterBar } from "../components/TaskFilterBar";
import type { TaskFilters } from "../model/taskFilters";
import { partitionColdTerminalTasks, sortByRecentThenPinAndFavoritesFirst } from "../model/taskFilters";
import { SegBar } from "../components/primitives/SegBar.tsx";
import { StatusTag } from "../components/primitives/StatusTag.tsx";
import { TitleText } from "../components/primitives/TitleText.tsx";
import { relativeTime } from "../sessions-model.ts";
import { TaskWipSummary } from "../components/TaskWipSummary.tsx";
import type { TaskWipRead } from "../../api/renderer-dto.ts";
import { ListView } from "./ListView";
import type { TaskMutationFeedback } from "../task-actions.ts";

const ENGINE_HINT: Record<string, string> = {
  multica: "由 Multica 管理，去 Multica 改状态",
  github: "由 GitHub Issues 管理，去 GitHub 改状态",
  linear: "由 Linear 管理，去 Linear 改状态",
};

/**
 * 卡片悬停提示只答「这行还能做什么」:动作可用性读行级能力投影(kernel
 * `taskCapabilities`),不再按状态词分支;overlay 提示保留 blockingAssessment 一格。
 */
function taskControlHint(task: TaskRow): string {
  if (isExternal(task)) return ENGINE_HINT[task.engine] ?? `由外部引擎 ${task.engine} 管理，GUI 只读`;
  if (task.visibility.archived) return `${task.packageDisposition} package 只读`;
  if (task.blocking === "blocked") return "Blocked 是 relation overlay，不可拖；关系在 canonical 来源处理";
  if (taskCan(task, "review")) return "已进入 review；只能查看 canonical settlement";
  if (taskCan(task, "start")) return "可拖到 Active 申请 execution lease";
  if (taskCan(task, "progress") || taskCan(task, "submit")) return "Active 状态请在详情追加 progress 或 request review";
  return "当前无可用动作，原因见详情控制面板";
}

/** 卡片的「一行原因」:只答为什么需要注意(阻塞判定),其余细节进预览抽屉。 */
function cardReason(task: TaskRow): string | undefined {
  if (task.blocking === "unknown") return "阻塞关系未能确定";
  if (task.coordinationStatus === "blocked" && task.canonicalStatus) return `canonical ${task.canonicalStatus}`;
  return undefined;
}

/**
 * 卡片 memo(W9):比较键是行对象引用 + 标量 props,不写自定义比较器;
 * 行级引用保持(task-adapter)保证未变行的 task 引用稳定,回调引用由上层
 * useCallback 稳定,所以「台账改一行」只有该行卡片重渲染。
 *
 * 卡片面(标准 §2.4):状态标签、标题(经 TitleText)、一行原因与时间;
 * 徽章与引擎/收口/决策来源等其余细节进预览抽屉(TaskPreviewDrawer),不上卡。
 */
const Card = memo(function Card({
  task,
  onSelect,
  dragging,
  isFavorite,
  onToggleFavorite,
  onSetPin,
}: {
  task: TaskRow;
  onSelect?: (id: string) => void;
  dragging?: boolean;
  isFavorite: boolean;
  onToggleFavorite: (id: string) => void;
  onSetPin?: (task: TaskRow, pinned: boolean) => void;
}) {
  const external = isExternal(task);
  const archived = task.visibility.archived;
  const reason = cardReason(task);
  return (
    <div
      data-testid="board-task-card"
      onClick={() => onSelect?.(task.taskId)}
      title={taskControlHint(task)}
      className={`relative cursor-pointer rounded-md bg-surface-raised p-2.5 ${freshnessBorder(
        task.freshness,
      )} ${archived ? "opacity-50" : ""} ${dragging ? "shadow-lg" : "hover:border-accent hover:ring-1 hover:ring-accent/50"} ${isFavorite ? "ring-1 ring-accent/40" : ""}`}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {external && <Lock weight="bold" className="shrink-0 ui-meta text-text-faint" aria-label="外部引擎只读" />}
        <StatusTag status={task.canonicalStatus ?? task.coordinationStatus} />
        {onSetPin ? (
          <button
            type="button"
            data-testid={`board-pin-toggle-${task.taskId}`}
            onClick={(event) => {
              event.stopPropagation();
              onSetPin(task, task.pinned !== true);
            }}
            title={task.pinned === true ? "解除 pin" : "Pin(今天当前在做)"}
            aria-pressed={task.pinned === true}
            className={`relative inline-flex items-center justify-center rounded p-0.5 ui-body hover:bg-surface after:absolute after:content-[''] after:-top-[12px] after:-bottom-[12px] after:-left-[12px] after:-right-[12px] ${
              task.pinned === true ? "text-accent" : "text-text-faint hover:text-text-muted"
            }`}
          >
            <PushPin weight={task.pinned === true ? "fill" : "bold"} />
          </button>
        ) : task.pinned === true ? (
          <span
            title="📌 今天当前在做"
            data-testid={`board-pinned-marker-${task.taskId}`}
            className="inline-flex items-center rounded border border-accent/40 px-1 ui-micro text-accent"
          >
            <PushPin weight="fill" />
          </span>
        ) : null}
        {archived && <span className="font-mono ui-micro text-text-faint">{task.packageDisposition}</span>}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onToggleFavorite(task.taskId);
          }}
          title={isFavorite ? "取消收藏" : "收藏(置顶)"}
          className={`relative ml-auto inline-flex items-center justify-center rounded p-0.5 ui-meta hover:bg-surface after:absolute after:content-[''] after:-top-[12px] after:-bottom-[12px] after:-left-[16px] after:-right-[8px] ${
            isFavorite ? "text-accent" : "text-text-faint hover:text-text-muted"
          }`}
        >
          <Star weight={isFavorite ? "fill" : "bold"} />
        </button>
      </div>
      <p className="mt-1.5 line-clamp-2 ui-prose leading-snug text-text">
        <TitleText title={task.title} />
      </p>
      <div className="mt-1.5 flex items-baseline gap-1.5">
        {reason !== undefined && <span className="min-w-0 truncate ui-meta text-text-faint">{reason}</span>}
        <span className="ml-auto shrink-0 font-mono ui-micro text-text-faint">{relativeTime(task.lastKnownAt)}</span>
      </div>
    </div>
  );
});

/**
 * draggable 收窄(W9):`useDraggable` 即使 disabled 也向 DndContext 注册节点,
 * 而全板唯一合法拖拽是 planned→active(`taskCan(task,"start")`),done/外部/
 * 归档卡全是无效注册。不可拖卡直接渲染 Card,可拖卡才挂 dnd。离屏卡的
 * 按需渲染由列内 windowing(W10)承担,卡片外层不再包 content-visibility。
 *
 * 可聚焦修正(W9 修正):不可拖卡保留 role=button/tabIndex=0 的可达表面,并补上
 * 与点击等价的 Enter/Space 键盘激活(baseline 本就没有键盘激活,属存量弱点,
 * 此处一并补齐);唯一省掉的是 dnd 注册本身。不再挂 aria-disabled:卡片选择
 * 始终可用,报 disabled 反而误导(非拖拽语义由悬停提示承担)。
 *
 * 键事件只认包装层自身发起的(target===currentTarget):卡内 pin/收藏是原生
 * button,自带 Enter/Space 激活,包装层不得替它们 preventDefault 或触发选卡。
 */
const DraggableCard = memo(function DraggableCard({
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
  if (!taskCan(task, "start")) {
    return (
      <div
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect(task.taskId);
          }
        }}
      >
        <Card
          task={task}
          onSelect={onSelect}
          isFavorite={isFavorite}
          onToggleFavorite={onToggleFavorite}
          onSetPin={onSetPin}
        />
      </div>
    );
  }
  return (
    <DndCard
      task={task}
      onSelect={onSelect}
      isFavorite={isFavorite}
      onToggleFavorite={onToggleFavorite}
      onSetPin={onSetPin}
    />
  );
});

function DndCard({
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
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.taskId });
  return (
    <div ref={setNodeRef} {...attributes} {...listeners} className={isDragging ? "opacity-30" : ""}>
      <Card
        task={task}
        onSelect={onSelect}
        isFavorite={isFavorite}
        onToggleFavorite={onToggleFavorite}
        onSetPin={onSetPin}
      />
    </div>
  );
}

/** 列内 windowing(W10):估算卡高含 8px 间距,实测由 measureElement 收敛。 */
const CARD_ESTIMATE_PX = 108;
const CARD_OVERSCAN = 6;
/** 列宽交互区间(W11):未定宽列走 basis-1/4 等分默认,一旦拖/微调就固定 px。 */
const COLUMN_WIDTH_RANGE = { min: 220, max: 720 } as const;

/**
 * 看板列(标准 §2.4):列标题一行 = 状态名 + 计数 + 细 SegBar;空列收窄成一条
 * 竖线,不留等宽空列(空了就消失,§1.5)。唯一例外:拖拽进行中的 active 列是
 * planned→active 的唯一合法落点,保持整列宽度,否则收窄后无处可放。
 */
function Column({
  status,
  tasks,
  onSelect,
  rejecting,
  dragging,
  favorites,
  onToggleFavorite,
  onSetPin,
  width,
  onResize,
  onReset,
}: {
  status: SnapshotStatus;
  tasks: readonly TaskRow[];
  onSelect: (id: string) => void;
  rejecting: boolean;
  /** 拖拽进行中且本列是 active(唯一合法落点):空列不收窄,保住放置面。 */
  dragging: boolean;
  favorites: ReadonlySet<string>;
  onToggleFavorite: (id: string) => void;
  onSetPin?: (task: TaskRow, pinned: boolean) => void;
  /** 持久化列宽;undefined = 默认等分布局。 */
  width: number | undefined;
  onResize: (status: SnapshotStatus, px: number) => void;
  onReset: (status: SnapshotStatus) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const meta = STATUS_META[status];
  // 列内默认序(W8):lastKnownAt 倒序打底,pin → 收藏稳定置顶。
  const ordered = sortByRecentThenPinAndFavoritesFirst(tasks, favorites);
  const empty = ordered.length === 0;

  // 按需渲染 = 列内 windowing(W10):每列只挂视口内 + overscan 的卡,DOM 卡片数
  // 与列总量解耦(基线:canonical done 单列 1699 卡全挂载)。2026-08-25 裁决的
  // 「性能顾虑用按需渲染解决」即此形态——不需要分批按钮,滚动到哪里挂到哪里。
  // 拖拽面不受影响:droppable 是列级(整列常挂),拖拽影像走 DragOverlay,
  // 源卡在拖拽中滚出视口被卸载也不破坏拖拽(dnd-kit 官方虚拟列表模式)。
  const listRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: ordered.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => CARD_ESTIMATE_PX,
    overscan: CARD_OVERSCAN,
    getItemKey: (index) => ordered[index].taskId,
  });

  // 空列收窄成一条竖线(标准 §2.4):状态色半透明的 3px 竖条,悬停给整列语义。
  if (empty && !dragging) {
    return (
      <div
        ref={setNodeRef}
        data-testid={`board-column-${status}`}
        title={`${meta.label} · 0`}
        className="w-[3px] shrink-0 self-stretch overflow-hidden rounded-full transition-colors"
        style={{ background: `color-mix(in oklch, ${meta.color} 45%, transparent)` }}
      />
    );
  }

  // 未定宽列保持 basis-1/4 等分默认;定宽后固定 px(两态都 shrink-0,越界走横向滚动)。
  const sizing = width === undefined ? "basis-1/4" : "";
  return (
    <div
      ref={setNodeRef}
      data-testid={`board-column-${status}`}
      style={width === undefined ? undefined : { width }}
      className={`relative flex shrink-0 ${sizing} flex-col rounded-sm p-2 transition-colors ${
        isOver && rejecting
          ? "bg-danger/5 outline outline-1 outline-dashed outline-danger/40"
          : isOver
            ? "bg-surface-raised/70"
            : "bg-surface"
      }`}
    >
      <ColumnResizeHandle
        label={`调整「${meta.label}」列宽`}
        width={width}
        min={COLUMN_WIDTH_RANGE.min}
        max={COLUMN_WIDTH_RANGE.max}
        onChange={(px) => onResize(status, px)}
        onReset={() => onReset(status)}
        testId={`board-column-resize-${status}`}
        className="inset-y-0 -right-1.5"
      />
      <div className="flex items-baseline gap-1.5 px-1.5 pb-1 pt-1">
        <span className="ui-body font-semibold">{meta.label}</span>
        <span className="font-mono ui-body text-text-faint" data-testid={`board-status-${status}-count`}>
          {tasks.length}
        </span>
        {isOver && rejecting && (
          <span className="ml-auto inline-flex items-center gap-1 ui-micro text-danger">
            <Lock weight="bold" />
            外部引擎管理
          </span>
        )}
      </div>
      <SegBar className="mx-1.5 mb-2" counts={{ [status]: tasks.length }} />
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto pb-1" data-testid={`board-column-list-${status}`}>
        {ordered.length > 0 ? (
          <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className="absolute inset-x-0 top-0 pb-2"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <DraggableCard
                  task={ordered[item.index]}
                  onSelect={onSelect}
                  isFavorite={favorites.has(ordered[item.index].taskId)}
                  onToggleFavorite={onToggleFavorite}
                  onSetPin={onSetPin}
                />
              </div>
            ))}
          </div>
        ) : (
          <div className="min-h-24 rounded-md border border-dashed border-border/60" />
        )}
      </div>
    </div>
  );
}

export type BoardLayout = "column" | "swimlane" | "list";

export const BoardView = memo(function BoardView({
  tasks,
  allTasks,
  wipSnapshot,
  filters,
  onFiltersChange,
  onSelect,
  drill,
  favorites,
  onToggleFavorite,
  initialLayout,
  initialGroupBy,
  onStartTask,
  mutationFeedback,
  onSetPin,
}: {
  tasks: readonly TaskRow[];
  allTasks: TaskRow[];
  wipSnapshot?: TaskWipRead;
  filters: TaskFilters;
  onFiltersChange: (filters: TaskFilters) => void;
  onSelect: (id: string) => void;
  drill?: { lane: string; status: SnapshotStatus; groupBy: LaneGroupBy } | null;
  favorites: ReadonlySet<string>;
  onToggleFavorite: (id: string) => void;
  initialLayout?: BoardLayout;
  initialGroupBy?: LaneGroupBy;
  onStartTask?: (task: TaskRow) => Promise<unknown>;
  mutationFeedback?: (taskId: string) => TaskMutationFeedback | undefined;
  /** 台账 pin 写通道;三种看板布局的 task 卡片/行共用。 */
  onSetPin?: (task: TaskRow, pinned: boolean) => void;
}) {
  // coding preset 默认按工作分组(root = 工作的根 task)。drill 携带 groupBy 提示。
  const [layout, setLayout] = useState<BoardLayout>(drill ? "swimlane" : (initialLayout ?? "column"));
  const [groupBy, setGroupBy] = useState<LaneGroupBy>(drill?.groupBy ?? initialGroupBy ?? "root");

  useEffect(() => {
    if (drill) {
      setLayout("swimlane");
      setGroupBy(drill.groupBy);
    }
  }, [drill]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const [activeTask, setActiveTask] = useState<TaskRow | null>(null);
  const [dragMessage, setDragMessage] = useState<string | null>(null);
  const [lastMutationTaskId, setLastMutationTaskId] = useState<string | null>(null);

  // 列宽偏好(W11):GUI 本地态,读写同 graph-density 模式;只在挂载时读一次,
  // 之后写穿透(每次调整都落 localStorage,重启/重载后保留)。
  const [columnWidths, setColumnWidths] = useState(() => readBoardColumnWidths(boardColumnPreferenceStorage()));
  const resizeColumn = useCallback(
    (status: SnapshotStatus, px: number) => {
      const next = setBoardColumnWidth(columnWidths, "column", status, px);
      setColumnWidths(next);
      writeBoardColumnWidths(boardColumnPreferenceStorage(), next);
    },
    [columnWidths],
  );
  const resetColumn = useCallback(
    (status: SnapshotStatus) => {
      const next = clearBoardColumnWidth(columnWidths, "column", status);
      setColumnWidths(next);
      writeBoardColumnWidths(boardColumnPreferenceStorage(), next);
    },
    [columnWidths],
  );

  // 看板默认降噪(W8):冷终态(终态且非重点种子,判定复用 isTaskGraphFocusSeed 的
  // 14 天窗口)默认折叠为可见计数,TaskFilterBar 提供展开开关;pinned 恒可见。
  // 折叠不是筛选:计数必须在两种开关状态下都可见,不允许静默消失(W6 先例)。
  const coldPartition = useMemo(() => partitionColdTerminalTasks(tasks, new Date().toISOString()), [tasks]);
  const boardTasks = filters.expandColdTerminal ? tasks : coldPartition.visible;

  // 列模式单遍分组(W9):一次遍历产出 status→rows,替代每列一次的 filter 链;
  // 分组键是看板列桶 boardColumnOf——归档行进 archived 列,活跃行进生命周期列
  // (task_8928cf1e)。boardTasks 引用未变时(useMemo 命中)各列数组引用也稳定。
  const columnsByStatus = useMemo(() => {
    const grouped = new Map<SnapshotStatus, TaskRow[]>(BOARD_COLUMNS.map((status) => [status, []]));
    for (const task of boardTasks) grouped.get(boardColumnOf(task))!.push(task);
    return grouped;
  }, [boardTasks]);

  // 列动态渲染(task_8928cf1e):状态 Pill 选中了哪几列就只渲染哪几列,未选中的
  // 列组件整列不进 DOM(不是掏空卡片占宽);空选 = 全部列。列序恒按
  // BOARD_COLUMNS,与 Pill 组一致。
  const visibleColumns = useMemo(
    () =>
      filters.status.length > 0 ? BOARD_COLUMNS.filter((status) => filters.status.includes(status)) : BOARD_COLUMNS,
    [filters.status],
  );

  // pin 也是一次台账写入:回执落定与投影追平之间有真实延迟(实测约 2s),那段时间
  // 按钮看起来「点了没反应」。写入报告面与拖拽 start 共用同一条,pin 也挂进去。
  const reportedSetPin = useCallback(
    (task: TaskRow, pinned: boolean) => {
      setDragMessage(null);
      setLastMutationTaskId(task.taskId);
      onSetPin?.(task, pinned);
    },
    [onSetPin],
  );
  const setPin = onSetPin ? reportedSetPin : undefined;

  const onDragStart = (e: DragStartEvent) => setActiveTask(boardTasks.find((t) => t.taskId === e.active.id) ?? null);

  const onDragEnd = (event: DragEndEvent) => {
    const task = activeTask;
    setActiveTask(null);
    if (!task) return;
    if (event.over?.id !== "active") {
      setDragMessage("唯一允许的 transition 是 planned → active；Blocked 不是状态机节点。");
      return;
    }
    setDragMessage(null);
    setLastMutationTaskId(task.taskId);
    void onStartTask?.(task);
  };

  // 段钮盒尺寸维持修复前(22.34px 高);命中区由伪元素纵向扩到 ≥40px——inset-x-0
  // 让空内容伪元素铺满段宽(否则 shrink-to-fit 塌成 0 宽没有命中面),段与段零间距
  // 横向相邻,横向不扩以免互抢点击(§1.9③)。
  const seg = (active: boolean) =>
    `relative rounded px-2 py-0.5 ui-meta after:absolute after:content-[''] after:inset-x-0 after:-top-[9px] after:-bottom-[9px] ${
      active ? "bg-surface-raised font-medium text-text" : "text-text-muted hover:text-text"
    }`;

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-baseline gap-3 border-b border-border px-4 py-2.5">
        <h1 className="ui-title font-semibold">看板</h1>
        <span className="ui-meta text-text-muted">各状态上压了多少、哪里堆积;点卡片看详情,planned 可拖到 Active</span>
        <span className="font-mono ui-body text-text-faint">
          {boardTasks.length}/{allTasks.length}
        </span>
        <TaskWipSummary snapshot={wipSnapshot} />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {layout === "swimlane" && (
            <span className="flex items-center gap-1.5">
              <span className="font-mono ui-micro uppercase tracking-wide text-text-faint">分组维度</span>
              <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
                {(["root", "engine", "productLine"] as const).map((d) => (
                  <button
                    key={d}
                    onClick={() => setGroupBy(d)}
                    title={
                      d === "root"
                        ? "按工作分组(根任务及其子树)"
                        : d === "engine"
                          ? "按引擎分组"
                          : "按 productLine(PLT)分组"
                    }
                    className={`font-mono ${seg(groupBy === d)}`}
                  >
                    {d === "root" ? "work" : d}
                  </button>
                ))}
              </div>
            </span>
          )}
          <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
            <button
              onClick={() => setLayout("column")}
              className={seg(layout === "column")}
              title="按 coordinationStatus 分列"
            >
              列
            </button>
            <button
              onClick={() => setLayout("swimlane")}
              className={seg(layout === "swimlane")}
              title="按分组维度 × 状态的泳道矩阵"
            >
              泳道
            </button>
            <button
              onClick={() => setLayout("list")}
              className={seg(layout === "list")}
              title="按注意力排序列表;终态折叠"
            >
              列表
            </button>
          </div>
        </div>
      </header>
      {(dragMessage || (lastMutationTaskId && mutationFeedback?.(lastMutationTaskId))) && (
        <div className="border-b border-border px-4 py-2 ui-meta text-text-muted" data-testid="board-mutation-feedback">
          {dragMessage ??
            (() => {
              const item = mutationFeedback?.(lastMutationTaskId!);
              return item
                ? `${item.kind} · ${item.state} · opId=${item.opId}${item.code ? ` · code=${item.code}` : ""} · ${item.hint}`
                : "";
            })()}
        </div>
      )}
      <TaskFilterBar
        tasks={allTasks}
        filteredCount={boardTasks.length}
        filters={filters}
        onChange={onFiltersChange}
        contextLabel="看板"
        favorites={favorites}
        coldTerminalCount={coldPartition.collapsed.length}
      />
      {layout === "list" ? (
        <ListView
          tasks={boardTasks}
          onSelect={onSelect}
          favorites={favorites}
          onToggleFavorite={onToggleFavorite}
          onSetPin={setPin}
        />
      ) : layout === "swimlane" ? (
        <SwimlaneBoard
          key={groupBy}
          tasks={boardTasks}
          columns={visibleColumns}
          groupBy={groupBy}
          onSelect={onSelect}
          drill={drill ?? null}
          favorites={favorites}
          onToggleFavorite={onToggleFavorite}
          onSetPin={setPin}
        />
      ) : (
        <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
          <div className="flex flex-1 items-stretch gap-3 overflow-x-auto p-4">
            {visibleColumns.map((status) => (
              <Column
                key={status}
                status={status}
                tasks={columnsByStatus.get(status)!}
                onSelect={onSelect}
                rejecting={activeTask ? isExternal(activeTask) : false}
                dragging={activeTask !== null && status === "active"}
                favorites={favorites}
                onToggleFavorite={onToggleFavorite}
                onSetPin={setPin}
                width={columnWidths.column[status]}
                onResize={resizeColumn}
                onReset={resetColumn}
              />
            ))}
          </div>
          <DragOverlay>
            {activeTask && (
              <div className="w-[256px] rotate-2">
                <Card
                  task={activeTask}
                  dragging
                  isFavorite={favorites.has(activeTask.taskId)}
                  onToggleFavorite={onToggleFavorite}
                />
              </div>
            )}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  );
});
