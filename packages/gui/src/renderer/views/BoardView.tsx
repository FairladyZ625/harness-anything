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
import { Lock, Archive } from "@phosphor-icons/react";
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
import { spawningDecisionOf } from "../model/triadic";

const ENGINE_HINT: Record<string, string> = {
  multica: "由 Multica 管理，去 Multica 改状态",
  github: "由 GitHub Issues 管理，去 GitHub 改状态",
  linear: "由 Linear 管理，去 Linear 改状态",
};

function Card({
  task,
  onSelect,
  dragging,
  relations,
}: {
  task: TaskRow;
  onSelect?: (id: string) => void;
  dragging?: boolean;
  relations: RelationEdge[];
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
      )} ${archived ? "opacity-50" : ""} ${dragging ? "shadow-lg" : "hover:border-border-strong"}`}
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-[13px] text-text-faint">{task.taskId}</span>
        <EngineBadge engine={task.engine} locked={external} />
        {archived && (
          <span className="ml-auto inline-flex items-center gap-1 font-mono text-[10px] text-text-faint">
            <Archive weight="bold" />
            {task.packageDisposition}
          </span>
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
}: {
  task: TaskRow;
  onSelect: (id: string) => void;
  relations: RelationEdge[];
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
      <Card task={task} onSelect={onSelect} relations={relations} />
    </div>
  );
}

function Column({
  status,
  tasks,
  onSelect,
  rejecting,
  relations,
}: {
  status: SnapshotStatus;
  tasks: TaskRow[];
  onSelect: (id: string) => void;
  rejecting: boolean;
  relations: RelationEdge[];
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const meta = STATUS_META[status];
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
            外部引擎管理
          </span>
        )}
      </div>
      <div className="flex flex-col gap-2 overflow-y-auto pb-1">
        {tasks.length > 0 ? (
          tasks.map((t) => (
            <DraggableCard key={t.taskId} task={t} onSelect={onSelect} relations={relations} />
          ))
        ) : (
          <div className="rounded-lg border border-dashed border-border px-3 py-5 text-[14px] text-text-faint">
            当前筛选下无 {meta.label} 任务
          </div>
        )}
      </div>
    </div>
  );
}

export function BoardView({
  tasks,
  allTasks,
  filters,
  onFiltersChange,
  onSelect,
  onUpdate,
  drill,
  relations,
}: {
  tasks: TaskRow[];
  allTasks: TaskRow[];
  filters: TaskFilters;
  onFiltersChange: (filters: TaskFilters) => void;
  onSelect: (id: string) => void;
  onUpdate: (id: string, patch: Partial<TaskRow>) => void;
  drill?: { module: string; status: SnapshotStatus } | null;
  relations: RelationEdge[];
}) {
  const [layout, setLayout] = useState<"column" | "swimlane">(
    drill ? "swimlane" : "column",
  );
  const [groupBy, setGroupBy] = useState<LaneGroupBy>("module");

  useEffect(() => {
    if (drill) {
      setLayout("swimlane");
      setGroupBy("module");
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
      <header className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        <h1 className="ui-title font-semibold">看板</h1>
        <span className="font-mono text-[13px] text-text-faint">
          {tasks.length}/{allTasks.length}
        </span>
        <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
          <button onClick={() => setLayout("column")} className={seg(layout === "column")}>
            列
          </button>
          <button
            onClick={() => setLayout("swimlane")}
            className={seg(layout === "swimlane")}
          >
            泳道
          </button>
        </div>
        <span className="text-[12px] text-text-faint">
          {layout === "column"
            ? "coordinationStatus 轴 · local 任务可拖拽"
            : "拖拽改状态请在列模式 · 外部任务任何模式都只读"}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <span className="font-mono text-[10px] uppercase tracking-wide text-text-faint">
            泳道分组
          </span>
          <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
            {(["module", "engine"] as const).map((d) => (
              <button
                key={d}
                onClick={() => setGroupBy(d)}
                className={`font-mono ${seg(groupBy === d)}`}
              >
                {d}
              </button>
            ))}
            <button
              disabled
              title="vertical 维度 · 规划中"
              className="cursor-not-allowed rounded px-2 py-0.5 font-mono text-[12px] text-text-faint opacity-50"
            >
              vertical
            </button>
          </div>
        </div>
      </header>
      <TaskFilterBar
        tasks={allTasks}
        filteredCount={tasks.length}
        filters={filters}
        onChange={onFiltersChange}
        contextLabel="看板"
      />
      {layout === "swimlane" ? (
        <SwimlaneBoard
          key={groupBy}
          tasks={tasks}
          groupBy={groupBy}
          onSelect={onSelect}
          drill={drill ?? null}
          relations={relations}
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
              />
            ))}
          </div>
          <DragOverlay>
            {activeTask && (
              <div className="w-[256px] rotate-2">
                <Card task={activeTask} dragging relations={relations} />
              </div>
            )}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  );
}
