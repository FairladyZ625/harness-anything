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
import { Lock, Archive, PushPin, Star } from "@phosphor-icons/react";
import type { TaskRow, SnapshotStatus } from "../model/types";
import { BOARD_COLUMNS, isExternal, taskCan } from "../model/types";
import {
  STATUS_META,
  CloseoutBadge,
  DecisionSourceBadge,
  EngineBadge,
  FreshnessTag,
  freshnessBorder,
} from "../components/badges";
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
import { spawningDecisionBadge } from "../model/triadic";
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

/**
 * 卡片 memo(W9):比较键是行对象引用 + 标量 props,不写自定义比较器;
 * 行级引用保持(task-adapter)保证未变行的 task 引用稳定,回调引用由上层
 * useCallback 稳定,所以「台账改一行」只有该行卡片重渲染。决策来源徽章从
 * 行内 placement 派生(唯一 derives 来源才有值),不依赖任何全局 relations。
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
  const spawningDecision = spawningDecisionBadge(task);
  return (
    <div
      data-testid="board-task-card"
      onClick={() => onSelect?.(task.taskId)}
      title={taskControlHint(task)}
      className={`group relative cursor-pointer rounded-lg bg-surface-raised p-2.5 ${freshnessBorder(
        task.freshness,
      )} ${archived ? "opacity-50" : ""} ${dragging ? "shadow-lg" : "hover:border-accent hover:ring-1 hover:ring-accent/50"} ${isFavorite ? "ring-1 ring-accent/40" : ""}`}
    >
      <div className="flex items-center gap-2">
        <EngineBadge engine={task.engine} locked={external} />
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
            className={`inline-flex items-center justify-center rounded p-0.5 ui-body hover:bg-surface ${
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
        {archived && (
          <span className="ml-auto inline-flex items-center gap-1 font-mono ui-micro text-text-faint">
            <Archive weight="bold" />
            {task.packageDisposition}
          </span>
        )}
        {!archived && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onToggleFavorite(task.taskId);
            }}
            title={isFavorite ? "取消收藏" : "收藏(置顶)"}
            className={`ml-auto inline-flex items-center justify-center rounded p-0.5 ui-meta hover:bg-surface ${
              isFavorite
                ? "text-accent opacity-100"
                : "text-text-faint opacity-0 hover:text-text-muted group-hover:opacity-100"
            }`}
          >
            <Star weight={isFavorite ? "fill" : "bold"} />
          </button>
        )}
      </div>
      <p className="mt-1.5 ui-prose leading-snug text-text">{task.title}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {task.coordinationStatus === "blocked" && task.canonicalStatus && (
          <span className="rounded border border-status-blocked/30 px-1 font-mono ui-micro text-status-blocked">
            canonical {task.canonicalStatus}
          </span>
        )}
        {task.blocking === "unknown" && (
          <span className="rounded border border-stale/30 px-1 ui-micro text-stale">阻塞关系未能确定</span>
        )}
        {spawningDecision && <DecisionSourceBadge decisionId={spawningDecision} compact />}
        <CloseoutBadge value={task.closeoutReadiness} />
        <FreshnessTag freshness={task.freshness} lastKnownAt={task.lastKnownAt} />
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

function Column({
  status,
  tasks,
  onSelect,
  rejecting,
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
  // 未定宽列保持 basis-1/4 等分默认;定宽后固定 px(两态都 shrink-0,越界走横向滚动)。
  const sizing = width === undefined ? "basis-1/4" : "";
  return (
    <div
      ref={setNodeRef}
      data-testid={`board-column-${status}`}
      style={width === undefined ? undefined : { width }}
      className={`relative flex shrink-0 ${sizing} flex-col rounded-xl p-2 transition-colors ${
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
      <div className="flex items-center gap-2 px-1.5 pb-2 pt-1">
        <span style={{ color: meta.color }} className="text-base">
          {meta.icon}
        </span>
        <span className="ui-prose font-semibold">{meta.label}</span>
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
          <div className="rounded-lg border border-dashed border-border px-3 py-5 ui-body text-text-faint">
            当前筛选下无 {meta.label} 任务
          </div>
        )}
      </div>
    </div>
  );
}

export type BoardLayout = "column" | "swimlane" | "list";

export const BoardView = memo(function BoardView({
  tasks,
  allTasks,
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
  // coding preset 默认按 root 分组(milestone=root task)。drill 携带 groupBy 提示。
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
  // boardTasks 引用未变时(useMemo 命中)各列数组引用也稳定。
  const columnsByStatus = useMemo(() => {
    const grouped = new Map<SnapshotStatus, TaskRow[]>(BOARD_COLUMNS.map((status) => [status, []]));
    for (const task of boardTasks) grouped.get(task.coordinationStatus)!.push(task);
    return grouped;
  }, [boardTasks]);

  // 徽章是行内 placement 的派生标量(spawningDecisionBadge),卡片/行组件按行自取,
  // 这里不再有跨行的派生索引,也不读任何关系切面。

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

  const seg = (active: boolean) =>
    `rounded px-2 py-0.5 ui-meta ${
      active ? "bg-surface-raised font-medium text-text" : "text-text-muted hover:text-text"
    }`;

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2.5">
        <h1 className="ui-title font-semibold">看板</h1>
        <span className="font-mono ui-body text-text-faint">
          {boardTasks.length}/{allTasks.length}
        </span>
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
            title="审计表格:每页行数可调,支持批量选择"
          >
            列表
          </button>
        </div>
        <span className="ui-meta text-text-faint">
          {layout === "column"
            ? "仅 native planned + blocking clear 可拖到 Active"
            : layout === "list"
              ? "审计面 · 支持 ID 复制与批量操作"
              : "拖拽改状态请在列模式 · 外部任务任何模式都只读"}
        </span>
        {layout !== "list" && (
          <div className="ml-auto flex items-center gap-1.5">
            <span className="font-mono ui-micro uppercase tracking-wide text-text-faint">分组维度</span>
            <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
              {(["root", "module", "engine", "productLine"] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => setGroupBy(d)}
                  title={
                    d === "root"
                      ? "按任务树根分组(milestone)"
                      : d === "module"
                        ? "按 module 维度(传统)"
                        : d === "engine"
                          ? "按引擎分组"
                          : "按 productLine(PLT)分组"
                  }
                  className={`font-mono ${seg(groupBy === d)}`}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>
        )}
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
          allTasks={allTasks}
          filters={filters}
          onFiltersChange={onFiltersChange}
          onSelect={onSelect}
          favorites={favorites}
          onToggleFavorite={onToggleFavorite}
          onSetPin={setPin}
          embedded
        />
      ) : layout === "swimlane" ? (
        <SwimlaneBoard
          key={groupBy}
          tasks={boardTasks}
          groupBy={groupBy}
          onSelect={onSelect}
          drill={drill ?? null}
          favorites={favorites}
          onToggleFavorite={onToggleFavorite}
          onSetPin={setPin}
        />
      ) : (
        <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
          <div className="flex flex-1 gap-3 overflow-x-auto p-4">
            {BOARD_COLUMNS.map((status) => (
              <Column
                key={status}
                status={status}
                tasks={columnsByStatus.get(status)!}
                onSelect={onSelect}
                rejecting={activeTask ? isExternal(activeTask) : false}
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
