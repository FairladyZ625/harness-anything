import { useEffect, useMemo, useState } from "react";
import { CaretRight, Lock } from "@phosphor-icons/react";
import type { TaskRow, SnapshotStatus, RelationEdge } from "../model/types";
import { BOARD_COLUMNS, isExternal } from "../model/types";
import {
  STATUS_META,
  CloseoutBadge,
  DecisionSourceBadge,
  FreshnessTag,
  freshnessBorder,
} from "../components/badges";
import { spawningDecisionOf } from "../model/triadic";

export type LaneGroupBy = "module" | "engine";

const PAGE_SIZE = 5;
const GRID_COLS = "grid-cols-[180px_repeat(7,230px)]";

const cellKey = (lane: string, status: SnapshotStatus) => `${lane}::${status}`;

type ActiveCell = { lane: string; status: SnapshotStatus };

function LaneCard({
  task,
  onSelect,
  relations,
}: {
  task: TaskRow;
  onSelect: (id: string) => void;
  relations: RelationEdge[];
}) {
  const external = isExternal(task);
  const archived = task.packageDisposition !== "active";
  const spawningDecision = spawningDecisionOf(task, relations);
  return (
    <div
      onClick={() => onSelect(task.taskId)}
      title={external ? "外部引擎管理 · 只读" : undefined}
      className={`flex min-h-[150px] cursor-pointer flex-col rounded-lg bg-surface-raised px-3.5 py-3 ${freshnessBorder(
        task.freshness,
      )} ${archived ? "opacity-50" : ""} hover:border-border-strong`}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 font-mono text-[13px] text-text-faint">
          {task.taskId}
        </span>
        {external && (
          <Lock weight="bold" className="ml-auto shrink-0 text-[13px] text-text-faint" />
        )}
      </div>
      <p className="mt-2 line-clamp-3 text-[15px] leading-snug text-text">
        {task.title}
      </p>
      <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-3">
        {spawningDecision && <DecisionSourceBadge decisionId={spawningDecision} compact />}
        <CloseoutBadge value={task.closeoutReadiness} />
        <FreshnessTag freshness={task.freshness} lastKnownAt={task.lastKnownAt} />
      </div>
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
  cellTasks: TaskRow[];
  selected: boolean;
  highlighted: boolean;
  onPick: () => void;
}) {
  const meta = STATUS_META[status];
  if (cellTasks.length === 0) {
    return (
      <div className="min-h-[62px] rounded-lg border border-border/60 bg-surface/30 px-3 py-2 text-center text-[14px] text-text-faint">
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
        background: selected
          ? `color-mix(in oklch, ${meta.color} 14%, var(--color-surface-raised))`
          : undefined,
      }}
    >
      <span className="flex items-center gap-2">
        <span
          className="inline-flex min-w-8 justify-center rounded-md px-2 py-0.5 font-mono text-[16px] font-semibold"
          style={{
            color: meta.color,
            background: `color-mix(in oklch, ${meta.color} 14%, transparent)`,
          }}
        >
          {cellTasks.length}
        </span>
        <span className="min-w-0 text-[13px] font-semibold text-text">
          {meta.label}
        </span>
        {selected && (
          <CaretRight weight="bold" className="ml-auto shrink-0 text-[13px] text-text-faint" />
        )}
      </span>
      <span className="mt-1.5 block truncate font-mono text-[12px] text-text-faint">
        {preview.taskId} · {preview.title}
      </span>
    </button>
  );
}

function DrilldownPanel({
  active,
  tasks,
  groupBy,
  onSelect,
  relations,
}: {
  active: ActiveCell | null;
  tasks: TaskRow[];
  groupBy: LaneGroupBy;
  onSelect: (id: string) => void;
  relations: RelationEdge[];
}) {
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    setShowAll(false);
  }, [active?.lane, active?.status]);

  if (!active) {
    return (
      <section className="min-h-[320px] shrink-0 bg-bg px-4 py-3">
        <div className="h-full rounded-lg border border-dashed border-border px-4 py-5 text-[15px] text-text-faint">
          选择上方泳道单元格后，在这里查看该组任务。
        </div>
      </section>
    );
  }

  const meta = STATUS_META[active.status];
  const visible = showAll ? tasks : tasks.slice(0, PAGE_SIZE);
  const hiddenCount = tasks.length - visible.length;

  return (
    <section className="min-h-[320px] shrink-0 bg-bg px-4 py-3">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[12px] uppercase tracking-wide text-text-faint">
          下钻结果
        </span>
        <span className="font-mono text-[15px] font-semibold text-text">
          {groupBy}: {active.lane}
        </span>
        <span className="inline-flex items-center gap-1.5 text-[15px] font-semibold">
          <span style={{ color: meta.color }} className="text-base">
            {meta.icon}
          </span>
          {meta.label}
        </span>
        <span className="font-mono text-[13px] text-text-faint">
          {tasks.length} tasks
        </span>
      </div>

      <div className="max-h-[280px] overflow-auto pr-1">
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2 2xl:grid-cols-3">
          {visible.map((t) => (
            <LaneCard key={t.taskId} task={t} onSelect={onSelect} relations={relations} />
          ))}
          {hiddenCount > 0 && (
            <button
              onClick={() => setShowAll(true)}
              className="min-h-[150px] rounded-lg border border-dashed border-border px-3 text-center font-mono text-[13px] text-text-muted hover:border-border-strong hover:text-text"
            >
              +{hiddenCount} 更多
            </button>
          )}
        </div>
      </div>

      {tasks.length === 0 && (
        <div className="rounded-lg border border-dashed border-border px-3 py-4 text-[15px] text-text-faint">
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
  relations,
}: {
  tasks: TaskRow[];
  groupBy: LaneGroupBy;
  onSelect: (id: string) => void;
  drill: { module: string; status: SnapshotStatus } | null;
  relations: RelationEdge[];
}) {
  const [activeCell, setActiveCell] = useState<ActiveCell | null>(
    () => (drill && groupBy === "module" ? { lane: drill.module, status: drill.status } : null),
  );

  useEffect(() => {
    if (drill && groupBy === "module")
      setActiveCell({ lane: drill.module, status: drill.status });
  }, [drill, groupBy]);

  const lanes = useMemo(
    () => [...new Set(tasks.map((t) => t[groupBy]))],
    [groupBy, tasks],
  );

  useEffect(() => {
    if (activeCell && !lanes.includes(activeCell.lane)) setActiveCell(null);
  }, [activeCell, lanes]);

  const highlight =
    drill && groupBy === "module" ? cellKey(drill.module, drill.status) : null;

  const activeTasks = useMemo(() => {
    if (!activeCell) return [];
    return tasks.filter(
      (t) =>
        t[groupBy] === activeCell.lane &&
        t.coordinationStatus === activeCell.status,
    );
  }, [activeCell, groupBy, tasks]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="max-h-[48vh] shrink-0 overflow-auto border-b border-border">
        <div className="min-w-max px-4 pb-4">
          <div
            className={`sticky top-0 z-10 grid ${GRID_COLS} gap-2 border-b border-border bg-bg py-2`}
          >
            <div className="self-center px-1.5 font-mono text-[12px] uppercase tracking-wide text-text-faint">
              {groupBy}
            </div>
            {BOARD_COLUMNS.map((status) => {
              const meta = STATUS_META[status];
              const total = tasks.filter((t) => t.coordinationStatus === status).length;
              return (
                <div key={status} className="flex items-center gap-1.5 px-1.5">
                  <span style={{ color: meta.color }} className="text-base">
                    {meta.icon}
                  </span>
                  <span className="text-[14px] font-semibold">{meta.label}</span>
                  <span className="font-mono text-[13px] text-text-faint">{total}</span>
                </div>
              );
            })}
          </div>
          {lanes.map((lane) => {
            const laneTasks = tasks.filter((t) => t[groupBy] === lane);
            return (
              <div
                key={lane}
                className={`grid ${GRID_COLS} gap-2 border-b border-border py-2.5`}
              >
                <div className="flex items-baseline gap-2 self-start px-1.5 pt-1.5">
                  <span className="font-mono text-[15px] font-semibold text-text">
                    {lane}
                  </span>
                  <span className="font-mono text-[13px] text-text-faint">
                    {laneTasks.length}
                  </span>
                </div>
                {BOARD_COLUMNS.map((status) => {
                  const key = cellKey(lane, status);
                  const selected =
                    activeCell?.lane === lane && activeCell.status === status;
                  return (
                    <LaneCell
                      key={status}
                      status={status}
                      cellTasks={laneTasks.filter((t) => t.coordinationStatus === status)}
                      selected={selected}
                      highlighted={highlight === key}
                      onPick={() => setActiveCell({ lane, status })}
                    />
                  );
                })}
              </div>
            );
          })}
          {lanes.length === 0 && (
            <div className="rounded-lg border border-dashed border-border px-4 py-8 text-[15px] text-text-faint">
              当前筛选下没有可展示的泳道任务。
            </div>
          )}
        </div>
      </div>
      <DrilldownPanel
        active={activeCell}
        tasks={activeTasks}
        groupBy={groupBy}
        onSelect={onSelect}
        relations={relations}
      />
    </div>
  );
}
