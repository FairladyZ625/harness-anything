import { useEffect, useMemo, useState } from "react";
import { CaretLeft, CaretRight, Lock } from "@phosphor-icons/react";
import type { TaskRow, RelationEdge } from "../model/types";
import { isExternal } from "../model/types";
import {
  CloseoutBadge,
  DecisionSourceBadge,
  EngineBadge,
  FreshnessTag,
  StatusBadge,
} from "../components/badges";
import { TaskFilterBar } from "../components/TaskFilterBar";
import type { TaskFilters } from "../model/taskFilters";
import { spawningDecisionOf } from "../model/triadic";

const PAGE_SIZE = 8;

const dateLabel = (iso: string) => iso.slice(5, 16).replace("T", " ");

function AuditRow({
  task,
  onSelect,
  selected,
  onToggleSelect,
  relations,
}: {
  task: TaskRow;
  onSelect: (id: string) => void;
  selected: boolean;
  onToggleSelect: (ev: React.MouseEvent) => void;
  relations: RelationEdge[];
}) {
  const archived = task.packageDisposition !== "active";
  const spawningDecision = spawningDecisionOf(task, relations);
  return (
    <tr
      role="button"
      tabIndex={0}
      onClick={() => onSelect(task.taskId)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onSelect(task.taskId);
      }}
      className={`cursor-pointer border-b border-border hover:bg-surface-raised/60 ${
        archived ? "opacity-55" : ""
      }`}
    >
      <td className="px-3 py-2 align-top" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={selected}
          onChange={() => {}}
          onClick={onToggleSelect}
          className="mt-1 accent-accent"
        />
      </td>
      <td className="px-3 py-2 align-top">
        <div className="font-mono text-[13px] text-text">{task.taskId}</div>
        <div className="mt-1 font-mono text-[12px] text-text-faint">
          {dateLabel(task.lastKnownAt)}
        </div>
      </td>
      <td className="min-w-[260px] px-3 py-2 align-top">
        <div className="line-clamp-2 text-[15px] font-medium leading-snug text-text">
          {task.title}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[12px] text-text-faint">
          <span>{task.module}</span>
          <span>{task.rawStatus}</span>
          {spawningDecision && <DecisionSourceBadge decisionId={spawningDecision} compact />}
          {isExternal(task) && (
            <span className="inline-flex items-center gap-1">
              <Lock weight="bold" />
              外部只读
            </span>
          )}
        </div>
      </td>
      <td className="px-3 py-2 align-top">
        <StatusBadge status={task.coordinationStatus} />
      </td>
      <td className="px-3 py-2 align-top">
        <CloseoutBadge value={task.closeoutReadiness} />
      </td>
      <td className="px-3 py-2 align-top">
        <EngineBadge engine={task.engine} locked={isExternal(task)} />
      </td>
      <td className="px-3 py-2 align-top">
        <FreshnessTag freshness={task.freshness} lastKnownAt={task.lastKnownAt} />
      </td>
      <td className="px-3 py-2 align-top">
        <span className="rounded border border-border px-1.5 py-px font-mono text-[12px] text-text-muted">
          {task.packageDisposition}
        </span>
      </td>
    </tr>
  );
}

export function ListView({
  tasks,
  allTasks,
  filters,
  onFiltersChange,
  onSelect,
  relations,
}: {
  tasks: TaskRow[];
  allTasks: TaskRow[];
  filters: TaskFilters;
  onFiltersChange: (filters: TaskFilters) => void;
  onSelect: (id: string) => void;
  relations: RelationEdge[];
}) {
  const [page, setPage] = useState(0);
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    setPage(0);
    setSelectedTaskIds(new Set());
  }, [filters, tasks.length]);

  const handleToggleSelect = (taskId: string, ev: React.MouseEvent) => {
    ev.stopPropagation();
    setSelectedTaskIds(prev => {
      const next = new Set(prev);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
      }
      return next;
    });
  };

  const sorted = useMemo(
    () => [...tasks].sort((a, b) => b.lastKnownAt.localeCompare(a.lastKnownAt)),
    [tasks],
  );
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const visible = sorted.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const externalCount = tasks.filter((task) => isExternal(task)).length;
  const riskCount = tasks.filter(
    (task) =>
      task.freshness !== "fresh" ||
      task.closeoutReadiness === "missing" ||
      task.closeoutReadiness === "failed",
  ).length;

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="ui-title font-semibold">列表</h1>
          <span className="font-mono text-[13px] text-text-faint">
            审计表格 · 定位任务、外部只读源、归档和投影风险
          </span>
          <span className="ml-auto font-mono text-[13px] text-text-faint">
            {tasks.length}/{allTasks.length} filtered
          </span>
        </div>
      </header>

      <TaskFilterBar
        tasks={allTasks}
        filteredCount={tasks.length}
        filters={filters}
        onChange={onFiltersChange}
        contextLabel="列表"
      />

      {selectedTaskIds.size > 0 && (
        <div className="flex items-center gap-3 bg-accent/10 border-b border-border/40 px-4 py-2 text-[13px]">
          <span className="font-semibold text-accent">批量操作 ({selectedTaskIds.size} 项已选):</span>
          <button
            onClick={() => {
              alert(`已模拟批量对任务 [${Array.from(selectedTaskIds).join(", ")}] 运行 Check！`);
              setSelectedTaskIds(new Set());
            }}
            className="rounded bg-accent px-2.5 py-1 font-semibold text-accent-fg hover:bg-accent/90 cursor-pointer"
          >
            批量运行 Check
          </button>
          <button
            onClick={() => {
              alert(`已模拟批量对任务 [${Array.from(selectedTaskIds).join(", ")}] 标记为 Ready！`);
              setSelectedTaskIds(new Set());
            }}
            className="rounded border border-border bg-surface px-2.5 py-1 hover:bg-surface-raised cursor-pointer"
          >
            批量标记 Ready
          </button>
          <button
            onClick={() => {
              alert(`已模拟批量对任务 [${Array.from(selectedTaskIds).join(", ")}] 进行归档！`);
              setSelectedTaskIds(new Set());
            }}
            className="rounded border border-border bg-surface px-2.5 py-1 hover:bg-surface-raised text-text-muted cursor-pointer"
          >
            批量归档
          </button>
          <button
            onClick={() => setSelectedTaskIds(new Set())}
            className="ml-auto text-text-faint hover:text-text cursor-pointer"
          >
            取消选择
          </button>
        </div>
      )}

      <div className="grid grid-cols-3 gap-3 border-b border-border px-4 py-3">
        <div className="rounded-lg border border-border bg-surface px-3 py-2">
          <div className="font-mono text-[12px] uppercase tracking-wide text-text-faint">
            当前结果
          </div>
          <div className="mt-1 font-mono text-[22px] font-semibold">{tasks.length}</div>
        </div>
        <div className="rounded-lg border border-border bg-surface px-3 py-2">
          <div className="font-mono text-[12px] uppercase tracking-wide text-text-faint">
            外部只读
          </div>
          <div className="mt-1 font-mono text-[22px] font-semibold">{externalCount}</div>
        </div>
        <div className="rounded-lg border border-border bg-surface px-3 py-2">
          <div className="font-mono text-[12px] uppercase tracking-wide text-text-faint">
            风险/失联
          </div>
          <div className="mt-1 font-mono text-[22px] font-semibold">{riskCount}</div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {visible.length === 0 ? (
          <div className="grid h-full place-items-center p-6">
            <div className="max-w-md rounded-lg border border-dashed border-border px-4 py-5 text-center">
              <div className="text-[16px] font-semibold text-text">没有匹配任务</div>
              <p className="mt-1 text-[14px] text-text-faint">
                放宽搜索、模块、状态或打开“含归档”查看隐藏任务。
              </p>
            </div>
          </div>
        ) : (
          <table className="w-full min-w-[980px] border-collapse text-left">
            <thead className="sticky top-0 z-10 bg-surface">
              <tr className="border-b border-border font-mono text-[12px] uppercase tracking-wide text-text-faint">
                <th className="w-10 px-3 py-2 font-medium">
                  <input
                    type="checkbox"
                    checked={visible.length > 0 && visible.every(t => selectedTaskIds.has(t.taskId))}
                    onChange={() => {
                      const allSelected = visible.every(t => selectedTaskIds.has(t.taskId));
                      setSelectedTaskIds(prev => {
                        const next = new Set(prev);
                        for (const t of visible) {
                          if (allSelected) {
                            next.delete(t.taskId);
                          } else {
                            next.add(t.taskId);
                          }
                        }
                        return next;
                      });
                    }}
                    className="accent-accent"
                  />
                </th>
                <th className="px-3 py-2 font-medium">task</th>
                <th className="px-3 py-2 font-medium">title / module</th>
                <th className="px-3 py-2 font-medium">status</th>
                <th className="px-3 py-2 font-medium">closeout</th>
                <th className="px-3 py-2 font-medium">engine</th>
                <th className="px-3 py-2 font-medium">freshness</th>
                <th className="px-3 py-2 font-medium">package</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((task) => (
                <AuditRow
                  key={task.taskId}
                  task={task}
                  onSelect={onSelect}
                  selected={selectedTaskIds.has(task.taskId)}
                  onToggleSelect={(ev) => handleToggleSelect(task.taskId, ev)}
                  relations={relations}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <footer className="flex items-center gap-2 border-t border-border px-4 py-2.5">
        <span className="font-mono text-[13px] text-text-faint">
          page {safePage + 1} / {pageCount}
        </span>
        <span className="font-mono text-[13px] text-text-faint">
          rows {visible.length} of {sorted.length}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            disabled={safePage === 0}
            onClick={() => setPage((current) => Math.max(0, current - 1))}
            className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-[13px] text-text-muted enabled:hover:bg-surface-raised enabled:hover:text-text disabled:opacity-40"
          >
            <CaretLeft weight="bold" />
            上一页
          </button>
          <button
            disabled={safePage >= pageCount - 1}
            onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
            className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-[13px] text-text-muted enabled:hover:bg-surface-raised enabled:hover:text-text disabled:opacity-40"
          >
            下一页
            <CaretRight weight="bold" />
          </button>
        </div>
      </footer>
    </div>
  );
}
