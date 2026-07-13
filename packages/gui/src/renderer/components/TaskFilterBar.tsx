import { useEffect, useRef, useState } from "react";
import { CaretDown, Check, MagnifyingGlass, Star, X } from "@phosphor-icons/react";
import type {
  CloseoutReadiness,
  EngineId,
  Freshness,
  SnapshotStatus,
  TaskRow,
} from "../model/types";
import { BOARD_COLUMNS } from "../model/types";
import { STATUS_META } from "./badges";
import {
  DEFAULT_TASK_FILTERS,
  hasActiveTaskFilters,
  taskFilterSummary,
  type TaskFilters,
} from "../model/taskFilters";

const ENGINES: (EngineId | "all")[] = ["all", "local", "multica"];
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

const STATUS_OPTIONS: SnapshotStatus[] = BOARD_COLUMNS;

function StatusMultiSelect({
  selected,
  onChange,
}: {
  selected: SnapshotStatus[];
  onChange: (next: SnapshotStatus[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const toggle = (status: SnapshotStatus) => {
    if (selected.includes(status)) onChange(selected.filter((s) => s !== status));
    else onChange([...selected, status]);
  };

  const label = selected.length === 0
    ? "全部"
    : selected.length === 1
      ? STATUS_META[selected[0]]?.label ?? selected[0]
      : `${selected.length} 项`;

  return (
    <div ref={containerRef} className="relative">
      <label className="flex items-center gap-1.5 text-[13px] text-text-faint">
        status
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={`inline-flex items-center gap-1 rounded-md border border-border bg-surface-raised px-2 py-1.5 text-[13px] text-text outline-none hover:border-border-strong ${
            selected.length > 0 ? "border-border-strong" : ""
          }`}
        >
          <span>{label}</span>
          <CaretDown weight="bold" className="text-[11px] text-text-faint" />
        </button>
      </label>
      {open && (
        <div className="absolute left-16 top-full z-30 mt-1 min-w-[200px] rounded-md border border-border-strong bg-surface-raised p-1 shadow-lg">
          {STATUS_OPTIONS.map((status) => {
            const meta = STATUS_META[status];
            const checked = selected.includes(status);
            return (
              <button
                key={status}
                type="button"
                onClick={() => toggle(status)}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-surface"
              >
                <span
                  className={`grid size-4 shrink-0 place-items-center rounded border ${
                    checked ? "border-accent bg-accent text-accent-fg" : "border-border"
                  }`}
                >
                  {checked && <Check weight="bold" className="text-[11px]" />}
                </span>
                <span style={{ color: meta?.color }} className="text-[14px]">
                  {meta?.icon}
                </span>
                <span className="text-text">{meta?.label ?? status}</span>
              </button>
            );
          })}
          {selected.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="mt-1 w-full rounded border border-border px-2 py-1 text-[12px] text-text-muted hover:bg-surface hover:text-text"
            >
              清空状态筛选
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function TaskFilterBar({
  tasks,
  filteredCount,
  filters,
  onChange,
  contextLabel,
  favorites,
}: {
  tasks: TaskRow[];
  filteredCount: number;
  filters: TaskFilters;
  onChange: (filters: TaskFilters) => void;
  contextLabel: string;
  favorites?: ReadonlySet<string>;
}) {
  const modules = [...new Set(tasks.map((task) => task.module))].sort();
  const chips = taskFilterSummary(filters);
  const active = hasActiveTaskFilters(filters);
  const favoriteCount = favorites ? tasks.filter((t) => favorites.has(t.taskId)).length : 0;

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
        <StatusMultiSelect
          selected={filters.status}
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

        {favorites && favoriteCount > 0 && (
          <button
            type="button"
            role="switch"
            aria-checked={filters.favoritesOnly}
            onClick={() => patch({ favoritesOnly: !filters.favoritesOnly })}
            className={`inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-[13px] ${
              filters.favoritesOnly
                ? "border-accent bg-accent/10 text-accent"
                : "border-border text-text-muted hover:bg-surface-raised"
            }`}
            title={`仅看收藏任务(共 ${favoriteCount} 个)`}
          >
            <Star weight={filters.favoritesOnly ? "fill" : "bold"} className="text-[12px]" />
            仅看收藏 · {favoriteCount}
          </button>
        )}

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
