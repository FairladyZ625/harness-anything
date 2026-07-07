import { MagnifyingGlass, X } from "@phosphor-icons/react";
import type {
  CloseoutReadiness,
  EngineId,
  Freshness,
  SnapshotStatus,
  TaskRow,
} from "../model/types";
import { BOARD_COLUMNS } from "../model/types";
import {
  DEFAULT_TASK_FILTERS,
  hasActiveTaskFilters,
  taskFilterSummary,
  type TaskFilters,
} from "../model/taskFilters";

const ENGINES: (EngineId | "all")[] = ["all", "local", "multica", "github", "linear"];
const CLOSEOUTS: (CloseoutReadiness | "all")[] = [
  "all",
  "ready",
  "missing",
  "incomplete",
  "failed",
  "passed",
  "not_required",
];
const FRESHNESS: (Freshness | "all")[] = [
  "all",
  "fresh",
  "stale-but-usable",
  "unavailable-no-cache",
];

function Select<T extends string>({
  label,
  value,
  values,
  onChange,
}: {
  label: string;
  value: T;
  values: T[];
  onChange: (value: T) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-[13px] text-text-faint">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        className="rounded-md border border-border bg-surface-raised px-2 py-1.5 text-[13px] text-text outline-none focus:border-border-strong"
      >
        {values.map((item) => (
          <option key={item} value={item}>
            {item === "all" ? "全部" : item}
          </option>
        ))}
      </select>
    </label>
  );
}

export function TaskFilterBar({
  tasks,
  filteredCount,
  filters,
  onChange,
  contextLabel,
}: {
  tasks: TaskRow[];
  filteredCount: number;
  filters: TaskFilters;
  onChange: (filters: TaskFilters) => void;
  contextLabel: string;
}) {
  const modules = [...new Set(tasks.map((task) => task.module))].sort();
  const chips = taskFilterSummary(filters);
  const active = hasActiveTaskFilters(filters);

  const patch = (next: Partial<TaskFilters>) => onChange({ ...filters, ...next });

  return (
    <section className="border-b border-border bg-surface/35 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-w-[260px] flex-1 items-center gap-2 rounded-md border border-border bg-surface-raised px-2.5 py-1.5 focus-within:border-border-strong">
          <MagnifyingGlass weight="bold" className="shrink-0 text-text-faint" />
          <input
            value={filters.query}
            onChange={(event) => patch({ query: event.target.value })}
            placeholder={`${contextLabel} 内搜索任务、模块、状态`}
            className="min-w-0 flex-1 bg-transparent text-[15px] text-text outline-none placeholder:text-text-faint"
          />
        </label>

        <Select
          label="module"
          value={filters.module}
          values={["all", ...modules]}
          onChange={(module) => patch({ module })}
        />
        <Select label="engine" value={filters.engine} values={ENGINES} onChange={(engine) => patch({ engine })} />
        <Select
          label="status"
          value={filters.status}
          values={["all", ...BOARD_COLUMNS] as (SnapshotStatus | "all")[]}
          onChange={(status) => patch({ status })}
        />
        <Select
          label="closeout"
          value={filters.closeout}
          values={CLOSEOUTS}
          onChange={(closeout) => patch({ closeout })}
        />
        <Select
          label="freshness"
          value={filters.freshness}
          values={FRESHNESS}
          onChange={(freshness) => patch({ freshness })}
        />

        <button
          type="button"
          role="switch"
          aria-checked={filters.includeArchived}
          onClick={() => patch({ includeArchived: !filters.includeArchived })}
          className={`rounded-md border px-3 py-1.5 text-[13px] ${
            filters.includeArchived
              ? "border-border-strong bg-surface-raised text-text"
              : "border-border text-text-muted hover:bg-surface-raised"
          }`}
        >
          含归档
        </button>

        {active && (
          <button
            onClick={() => onChange(DEFAULT_TASK_FILTERS)}
            className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-[13px] text-text-muted hover:bg-surface-raised hover:text-text"
          >
            <X weight="bold" />
            清除
          </button>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 font-mono text-[12px] text-text-faint">
        <span>
          {filteredCount} / {tasks.length} tasks
        </span>
        {chips.length > 0 ? (
          chips.map((chip) => (
            <span key={chip} className="rounded border border-border px-1.5 py-px">
              {chip}
            </span>
          ))
        ) : (
          <span>默认隐藏 archived / cancelled，降低噪音</span>
        )}
      </div>
    </section>
  );
}
