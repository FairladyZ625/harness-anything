import { useEffect, useState } from "react";
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
import { Lock, Archive, Star } from "@phosphor-icons/react";
import type { TaskRow, SnapshotStatus, RelationEdge } from "../model/types";
import { BOARD_COLUMNS, isExternal, isTerminal } from "../model/types";
import {
  STATUS_META,
  CloseoutBadge,
  DecisionSourceBadge,
  EngineBadge,
  FreshnessTag,
  freshnessBorder,
} from "../components/badges";
import { SwimlaneBoard, type LaneGroupBy } from "./SwimlaneBoard";
import { TaskFilterBar } from "../components/TaskFilterBar";
import type { TaskFilters } from "../model/taskFilters";
import { sortByFavoritesFirst } from "../model/taskFilters";
import { spawningDecisionOf } from "../model/triadic";
import { ListView } from "./ListView";
import { t } from "../i18n/index.tsx";

const ENGINE_HINT: Record<string, string> = {
  get multica() { return t("views.boardView.managedByMulticaGoMulticaChangeStatus"); },
};

function Card({
  task,
  onSelect,
  dragging,
  relations,
  isFavorite,
  onToggleFavorite,
}: {
  task: TaskRow;
  onSelect?: (id: string) => void;
  dragging?: boolean;
  relations: RelationEdge[];
  isFavorite: boolean;
  onToggleFavorite: (id: string) => void;
}) {
  const external = isExternal(task);
  const archived = task.packageDisposition !== "active";
  const spawningDecision = spawningDecisionOf(task, relations);
  return (
    <div
      onClick={() => onSelect?.(task.taskId)}
      title={external ? ENGINE_HINT[task.engine] : undefined}
      className={`group relative cursor-pointer rounded-lg bg-surface-raised p-2.5 ${freshnessBorder(
        task.freshness,
      )} ${archived ? "opacity-50" : ""} ${dragging ? "shadow-lg" : "hover:border-border-strong"} ${isFavorite ? "ring-1 ring-accent/40" : ""}`}
    >
      <div className="flex items-center gap-2">
        <EngineBadge engine={task.engine} locked={external} />
        {archived && (
          <span className="ml-auto inline-flex items-center gap-1 font-mono text-[10px] text-text-faint">
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
            title={isFavorite ? t("views.boardView.cancelFavorites") : t("views.boardView.favoritesPinned")}
            className={`ml-auto inline-flex items-center justify-center rounded p-0.5 text-[12px] hover:bg-surface ${
              isFavorite
                ? "text-accent opacity-100"
                : "text-text-faint opacity-0 hover:text-text-muted group-hover:opacity-100"
            }`}
          >
            <Star weight={isFavorite ? "fill" : "bold"} />
          </button>
        )}
      </div>
      <p className="mt-1.5 text-[15px] leading-snug text-text">{task.title}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {spawningDecision && <DecisionSourceBadge decisionId={spawningDecision} compact />}
        <CloseoutBadge value={task.closeoutReadiness} />
        <FreshnessTag freshness={task.freshness} lastKnownAt={task.lastKnownAt} />
      </div>
    </div>
  );
}

function DraggableCard({
  task,
  onSelect,
  relations,
  isFavorite,
  onToggleFavorite,
}: {
  task: TaskRow;
  onSelect: (id: string) => void;
  relations: RelationEdge[];
  isFavorite: boolean;
  onToggleFavorite: (id: string) => void;
}) {
  // external 任务允许拿起、落下被拒，让护栏可感知；终态完全锁定
  const draggable = !isTerminal(task.coordinationStatus);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.taskId,
    disabled: !draggable,
  });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={isDragging ? "opacity-30" : ""}
    >
      <Card
        task={task}
        onSelect={onSelect}
        relations={relations}
        isFavorite={isFavorite}
        onToggleFavorite={onToggleFavorite}
      />
    </div>
  );
}

function Column({
  status,
  tasks,
  onSelect,
  rejecting,
  relations,
  favorites,
  onToggleFavorite,
}: {
  status: SnapshotStatus;
  tasks: TaskRow[];
  onSelect: (id: string) => void;
  rejecting: boolean;
  relations: RelationEdge[];
  favorites: ReadonlySet<string>;
  onToggleFavorite: (id: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const meta = STATUS_META[status];
  const ordered = sortByFavoritesFirst(tasks, (t) => t.taskId, favorites);
  return (
    <div
      ref={setNodeRef}
      className={`flex w-[280px] shrink-0 flex-col rounded-xl p-2 transition-colors ${
        isOver && rejecting
          ? "bg-danger/5 outline outline-1 outline-dashed outline-danger/40"
          : isOver
            ? "bg-surface-raised/70"
            : "bg-surface"
      }`}
    >
      <div className="flex items-center gap-2 px-1.5 pb-2 pt-1">
        <span style={{ color: meta.color }} className="text-base">
          {meta.icon}
        </span>
        <span className="text-[15px] font-semibold">{meta.label}</span>
        <span className="font-mono text-[13px] text-text-faint">{tasks.length}</span>
        {isOver && rejecting && (
          <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-danger">
            <Lock weight="bold" />
            {t("views.boardView.externalEngineManagement")}</span>
        )}
      </div>
      <div className="flex flex-col gap-2 overflow-y-auto pb-1">
        {ordered.length > 0 ? (
          ordered.map((t) => (
            <DraggableCard
              key={t.taskId}
              task={t}
              onSelect={onSelect}
              relations={relations}
              isFavorite={favorites.has(t.taskId)}
              onToggleFavorite={onToggleFavorite}
            />
          ))
        ) : (
          <div className="rounded-lg border border-dashed border-border px-3 py-5 text-[14px] text-text-faint">
            {t("views.boardView.noneCurrentlyFiltered")}{meta.label} {t("views.boardView.task")}</div>
        )}
      </div>
    </div>
  );
}

export type BoardLayout = "column" | "swimlane" | "list";

export function BoardView({
  tasks,
  allTasks,
  filters,
  onFiltersChange,
  onSelect,
  onUpdate,
  drill,
  relations,
  favorites,
  onToggleFavorite,
  initialLayout,
  initialGroupBy,
}: {
  tasks: TaskRow[];
  allTasks: TaskRow[];
  filters: TaskFilters;
  onFiltersChange: (filters: TaskFilters) => void;
  onSelect: (id: string) => void;
  onUpdate: (id: string, patch: Partial<TaskRow>) => void;
  drill?: { lane: string; status: SnapshotStatus; groupBy: LaneGroupBy } | null;
  relations: RelationEdge[];
  favorites: ReadonlySet<string>;
  onToggleFavorite: (id: string) => void;
  initialLayout?: BoardLayout;
  initialGroupBy?: LaneGroupBy;
}) {
  // coding preset 默认按 root 分组(milestone=root task)。drill 携带 groupBy 提示。
  const [layout, setLayout] = useState<BoardLayout>(
    drill ? "swimlane" : initialLayout ?? "column",
  );
  const [groupBy, setGroupBy] = useState<LaneGroupBy>(
    drill?.groupBy ?? initialGroupBy ?? "root",
  );

  useEffect(() => {
    if (drill) {
      setLayout("swimlane");
      setGroupBy(drill.groupBy);
    }
  }, [drill]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );
  const [activeTask, setActiveTask] = useState<TaskRow | null>(null);

  const onDragStart = (e: DragStartEvent) =>
    setActiveTask(tasks.find((t) => t.taskId === e.active.id) ?? null);

  const onDragEnd = (e: DragEndEvent) => {
    setActiveTask(null);
    const target = e.over?.id as SnapshotStatus | undefined;
    if (!target || target === "unknown") return;
    const task = tasks.find((t) => t.taskId === e.active.id);
    if (!task || isExternal(task)) return;
    if (target === task.coordinationStatus) return;
    onUpdate(task.taskId, { coordinationStatus: target, rawStatus: target });
  };

  const seg = (active: boolean) =>
    `rounded px-2 py-0.5 text-[12px] ${
      active ? "bg-surface-raised font-medium text-text" : "text-text-muted hover:text-text"
    }`;

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2.5">
        <h1 className="ui-title font-semibold">{t("views.boardView.kanban")}</h1>
        <span className="font-mono text-[13px] text-text-faint">
          {tasks.length}/{allTasks.length}
        </span>
        <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
          <button
            onClick={() => setLayout("column")}
            className={seg(layout === "column")}
            title={t("views.boardView.sortedByCoordinationStatusCanDraggedChangeStatus")}
          >
            {t("views.boardView.column")}</button>
          <button
            onClick={() => setLayout("swimlane")}
            className={seg(layout === "swimlane")}
            title={t("views.boardView.swimlaneMatrixByGroupingDimensionState")}
          >
            {t("views.boardView.lane")}</button>
          <button
            onClick={() => setLayout("list")}
            className={seg(layout === "list")}
            title={t("views.boardView.auditFormNumberRowsPerPageAdjustable")}
          >
            {t("views.boardView.list")}</button>
        </div>
        <span className="text-[12px] text-text-faint">
          {layout === "column"
            ? t("views.boardView.coordinationStatusAxisLocalTaskCanDragged")
            : layout === "list"
              ? t("views.boardView.auditSurfaceSupportsIdCopyBatchOperations")
              : t("views.boardView.dragDropChangeStatusColumnModeExternal")}
        </span>
        {layout !== "list" && (
          <div className="ml-auto flex items-center gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-wide text-text-faint">
              {t("views.boardView.groupingDimensions")}</span>
            <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
              {(["root", "module", "engine"] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => setGroupBy(d)}
                  title={
                    d === "root"
                      ? t("views.boardView.groupByTaskTreeRootMilestone")
                      : d === "module"
                        ? t("views.boardView.byModuleDimensionTraditional")
                        : t("views.boardView.groupByEngine")
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
      <TaskFilterBar
        tasks={allTasks}
        filteredCount={tasks.length}
        filters={filters}
        onChange={onFiltersChange}
        contextLabel={t("views.boardView.kanban")}
        favorites={favorites}
      />
      {layout === "list" ? (
        <ListView
          tasks={tasks}
          allTasks={allTasks}
          filters={filters}
          onFiltersChange={onFiltersChange}
          onSelect={onSelect}
          relations={relations}
          favorites={favorites}
          onToggleFavorite={onToggleFavorite}
          embedded
        />
      ) : layout === "swimlane" ? (
        <SwimlaneBoard
          key={groupBy}
          tasks={tasks}
          groupBy={groupBy}
          onSelect={onSelect}
          drill={drill ?? null}
          relations={relations}
          favorites={favorites}
          onToggleFavorite={onToggleFavorite}
        />
      ) : (
        <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
          <div className="flex flex-1 gap-3 overflow-x-auto p-4">
            {BOARD_COLUMNS.map((status) => (
              <Column
                key={status}
                status={status}
                tasks={tasks.filter((t) => t.coordinationStatus === status)}
                onSelect={onSelect}
                rejecting={activeTask ? isExternal(activeTask) : false}
                relations={relations}
                favorites={favorites}
                onToggleFavorite={onToggleFavorite}
              />
            ))}
          </div>
          <DragOverlay>
            {activeTask && (
              <div className="w-[256px] rotate-2">
                <Card
                  task={activeTask}
                  dragging
                  relations={relations}
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
}
